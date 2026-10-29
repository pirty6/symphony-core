/**
 * Studio API: REST + Server-Sent Events over the deterministic runtime.
 *
 *   GET  /api/patterns?extras=on|off      library (built-in, optional, drafts) as graphs;
 *                                          extras unset: as SYMPHONY_EXTRAS says
 *   POST /api/validate        {pattern}    static validation
 *   POST /api/typescript      {pattern}    TypeScript source for a pattern
 *   POST /api/patterns        {pattern}    save as src/patterns/drafts/<name>.ts
 *   POST /api/draft           {request}    AI drafts a pattern (SSE stream)
 *   POST /api/runs            {pattern, goal, context, provider, ...} -> { runId, score }
 *   GET  /api/runs                         runs started by this server, newest first
 *   GET  /api/runs/:id/events              SSE: engine + provider + status messages
 *   POST /api/runs/:id/control {action}    pause | resume | step | stop | breakpoints | stepMode
 *   POST /api/runs/:id/approval {approved, updates, scripted}
 *   POST /api/runs {…, chain: [pattern…]}: patterns to play after it with its result
 *   POST /api/runs/:id/recovery {action: retry|stop, hint?, complexity?}  (a stuck AI step)
 *   GET  /api/copilot/status               { signedIn, login?, message }: can Copilot run here
 *   GET  /api/saved                        saved runs
 *   POST /api/saved/prune {dryRun?}        retention: delete old demo runs, compact old runs
 *   POST /api/saved/delete {path}           delete one saved run (not one still playing)
 *   GET  /api/saved/file?path=             saved run + integrity + replay check
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import { CompileError, compileScore } from '../../../src/core/compile.js'
import { parseDraft, patternToTypeScript } from '../../../src/core/draft.js'
import { patternToGraph } from '../../../src/core/graph.js'
import { engineNote } from '../../../src/core/migrate.js'
import { replayPerformance, restoreEngine } from '../../../src/core/replay.js'
import { isImprovisation, playsFromRepertoire } from '../../../src/core/jazz.js'
import type { Complexity, ExecutableScore, Pattern } from '../../../src/core/types.js'
import { chainNext } from '../../../src/runtime/chain.js'
import type { ChainStep } from '../../../src/core/chain.js'
import { concertNext } from '../../../src/runtime/concert.js'
import { validatePattern } from '../../../src/core/validate.js'
import { libraryPatterns, PATTERNS } from '../../../src/patterns/index.js'
import { enabledExtras } from '../../../src/patterns/extras/index.js'
import { draftPattern } from '../../../src/runtime/drafting.js'
import { Run, type RunOptions } from '../../../src/runtime/driver.js'
import {
  effectiveTiers,
  envConfig,
  isProviderName,
  makeProvider,
  runtimeExtras,
  type RuntimeExtras,
} from '../../../src/runtime/factory.js'
import { isolate, editsFiles } from '../../../src/runtime/worktree.js'
import { autoPrune, deleteRun, gitFingerprint, pruneRuns, runScratch, listRuns, loadPatternFiles, loadRepertoire, loadRun, runPath, savePatternFile, saveRun, runsDirFor } from '../../../src/runtime/store.js'

export interface ApiOptions {
  /** Repository root (where src/patterns lives). */
  readonly repoRoot: string
  /** Directory agents work in. Defaults to repoRoot. */
  readonly workspace?: string
  /** Loads a TypeScript pattern module (Vite ssrLoadModule in dev, import() in tests). */
  readonly importer: (file: string) => Promise<Record<string, unknown>>
  /** Streaming delay for the scripted provider, so runs are watchable. */
  readonly scriptedDelayMs?: number
  readonly env?: NodeJS.ProcessEnv
  /** Shared run table, so live runs survive an API reload in dev. */
  readonly runs?: Map<string, Run>
}

export const RUNS_DIR = '.symphony/runs'
let counter = 0
export const DRAFTS_DIR = 'src/patterns/drafts'
const TERMINAL = new Set(['done', 'failed', 'cancelled'])

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

/**
 * The API runs agents and writes pattern files, so it only accepts JSON POSTs from the studio's own
 * origin. Browsers cannot send application/json cross-site without a CORS preflight, which is never granted.
 */
export function refuseCrossSite(req: IncomingMessage): string | undefined {
  const type = String(req.headers['content-type'] ?? '')
  if (!type.startsWith('application/json')) return 'content-type must be application/json'
  const origin = req.headers.origin
  if (origin) {
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      return 'invalid origin'
    }
    if (host !== req.headers.host) return 'cross-origin requests are not allowed'
  }
  return undefined
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
}

function sse(res: ServerResponse, data: unknown, id?: number): void {
  res.write(`${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
}

/** Strip anything that is not plain pattern data (demo functions never cross the wire). */
function asPattern(raw: unknown): Pattern {
  const parsed = parseDraft(raw)
  if (parsed.ok) return parsed.value
  throw new CompileError(parsed.errors.map((message) => ({ message })))
}

export function createApi(opts: ApiOptions) {
  const runs = opts.runs ?? new Map<string, Run>()
  /** The file each run saves its checkpoints to, so a run still playing is not deleted. */
  const savedFiles = new Map<string, string>()
  const env = opts.env ?? process.env
  const workspace = opts.workspace ?? opts.repoRoot
  const runsDir = runsDirFor(opts.repoRoot, env)
  const draftsDir = join(opts.repoRoot, DRAFTS_DIR)
  const scratchDir = join(workspace, '.symphony', 'scratch')
  void autoPrune(workspace, runsDir, env)

  /**
   * The library. Optional patterns: 'env' = as SYMPHONY_EXTRAS says (the studio's default),
   * 'on'/'off' = the studio's toggle. Lookups use 'on', so a run of an extra still resumes.
   */
  async function library(
    extrasMode: 'env' | 'on' | 'off' = 'on',
  ): Promise<{ pattern: Pattern; source: 'builtin' | 'extra' | 'draft' }[]> {
    const drafts = await loadPatternFiles(draftsDir, opts.importer)
    const withExtras = extrasMode === 'env' ? env : { ...env, SYMPHONY_EXTRAS: extrasMode === 'on' ? 'all' : '' }
    const extras = new Set(enabledExtras(withExtras).map((p) => p.name))
    return libraryPatterns(withExtras, drafts).map((pattern) => ({
      pattern,
      source: PATTERNS.includes(pattern) ? ('builtin' as const) : extras.has(pattern.name) ? ('extra' as const) : ('draft' as const),
    }))
  }

  async function demoFor(name: string) {
    return (await library()).find((l) => l.pattern.name === name)?.pattern.demo
  }

  let extras: Promise<RuntimeExtras> | undefined
  const runtime = () => (extras ??= runtimeExtras(workspace, opts.repoRoot, env))

  function providerFor(name: unknown, model: unknown, pattern?: Pattern, mcpServers?: RuntimeExtras['mcpServers'], dir = workspace) {
    if (!isProviderName(name)) throw new CompileError([{ message: 'provider must be scripted or copilot' }])
    return makeProvider({
      provider: name,
      ...(pattern ? { pattern } : {}),
      workingDirectory: dir,
      delayMs: opts.scriptedDelayMs ?? 0,
      ...(mcpServers ? { mcpServers } : {}),
      ...envConfig(env),
      ...(typeof model === 'string' && model ? { model } : {}),
    })
  }

  interface Settings {
    readonly provider: unknown
    readonly model: unknown
    readonly autoApprove: boolean
    readonly stepMode: boolean
    readonly breakpoints: string[]
    readonly restore?: RunOptions['restore']
    /** Patterns (or backlog items) to play after this one. */
    readonly chain?: readonly ChainStep[]
  }

  async function launch(score: ExecutableScore, pattern: Pattern, settings: Settings): Promise<Run> {
    const demo = pattern.demo ?? (await demoFor(pattern.name))
    const withDemo: Pattern = demo ? { ...pattern, demo } : pattern
    const { tools, toolContext: shared, mcpServers } = await runtime()
    // A real AI editing files plays in its own worktree, so runs can play at once.
    const isolation =
      settings.provider === 'copilot' && editsFiles(score) ? await isolate(workspace, score.pattern, env) : undefined
    const dir = isolation?.dir ?? workspace
    const toolContext = isolation ? { ...shared, workspace: dir } : shared
    const provider = providerFor(settings.provider ?? 'scripted', settings.model, withDemo, mcpServers, dir)
    const id = `run-${Date.now().toString(36)}-${(counter++).toString(36)}`
    const next = concertNext({
      maestroScore: score,
      // The composed score plays with the same settings, starting fresh (no breakpoints).
      start: async (s, p, chain) => (await launch(s, p, { ...settings, breakpoints: [], chain })).id,
    }) ?? chainNext({
      chain: settings.chain ?? [],
      score,
      library: async () => (await library()).map((l) => l.pattern),
      improvisation: score.improvisation,
      start: async (s, p, rest) => (await launch(s, p, { ...settings, breakpoints: [], chain: rest })).id,
    })
    const run = new Run({
      id,
      score,
      provider,
      tools,
      toolContext,
      ...(demo ? { demo } : {}),
      ...(playsFromRepertoire(score.improvisation) ? { repertoire: await loadRepertoire(runsDir) } : {}),
      autoApprove: settings.autoApprove,
      stepMode: settings.stepMode,
      breakpoints: settings.breakpoints,
      ...(provider.name === 'copilot'
        ? { envHash: () => gitFingerprint(dir), scratch: await runScratch(workspace) }
        : {}),
      ...(isolation ? { isolation } : {}),
      onSave: async (r) => {
        const file = await saveRun(runsDir, r)
        savedFiles.set(id, file)
        return file
      },
      checkpoint: true,
      ...(settings.restore ? { restore: settings.restore } : {}),
      ...(next ? { next } : {}),
    })
    runs.set(run.id, run)
    void run.start().finally(() => provider.dispose?.())
    return run
  }

  async function startRun(body: Record<string, unknown>): Promise<Run> {
    const pattern = asPattern(body.pattern)
    const complexity = [1, 2, 3, 4].includes(body.complexity as number) ? (body.complexity as Complexity) : undefined
    const improvisation = isImprovisation(body.improvisation) ? body.improvisation : undefined
    const score = compileScore(pattern, {
      goal: typeof body.goal === 'string' && body.goal.trim() ? body.goal : pattern.description || pattern.name,
      context: (body.context as Record<string, unknown> | undefined) ?? {},
      ...(complexity ? { complexity } : {}),
      ...(improvisation !== undefined ? { improvisation } : {}),
    })
    return launch(score, pattern, {
      provider: body.provider,
      model: body.model,
      autoApprove: body.autoApprove === true,
      stepMode: body.stepMode === true,
      breakpoints: Array.isArray(body.breakpoints) ? body.breakpoints.map(String) : [],
      chain: Array.isArray(body.chain) ? body.chain.filter((t): t is string => typeof t === 'string' && t !== 'maestro') : [],
    })
  }

  /** Resume an interrupted run in place, or fork a saved run from a step as a new run. */
  async function continueRun(body: Record<string, unknown>): Promise<Run> {
    const file = runPath(runsDir, typeof body.file === 'string' ? body.file : '')
    if (!file) throw new CompileError([{ message: 'invalid run file' }])
    const { run: saved, issues } = await loadRun(file)
    if (issues.length) throw new CompileError(issues.map((message) => ({ message })))
    const kind = body.kind === 'forked' ? 'forked' : 'resumed'
    const perf = saved.performance
    const last = perf.steps.at(-1)?.step ?? 0
    if (kind === 'resumed' && perf.outcome !== 'in-progress' && perf.outcome !== 'cancelled') {
      throw new CompileError([{ message: `this run already ended (${perf.outcome}); fork it from a step instead` }])
    }
    const at = Number(body.atStep)
    if (kind === 'forked' && (!Number.isInteger(at) || at < 1 || at > last + 1)) {
      throw new CompileError([{ message: `atStep must be a step from 1 to ${last + 1}` }])
    }
    const throughStep = kind === 'forked' ? at - 1 : last
    let result
    try {
      result = restoreEngine(saved.score, perf, kind === 'forked' ? { throughStep, startedAt: new Date().toISOString() } : {})
    } catch (e) {
      throw new CompileError([{ message: (e as Error).message }])
    }
    const known = (await library()).find((l) => l.pattern.name === saved.score.pattern)?.pattern
    const pattern: Pattern = known ?? {
      name: saved.score.pattern,
      description: saved.score.description,
      requiredContext: [],
      state: saved.score.state,
      nodes: saved.score.nodes,
      edges: saved.score.edges,
      start: saved.score.start,
    }
    return launch(saved.score, pattern, {
      provider: body.provider,
      model: body.model,
      autoApprove: body.autoApprove === true,
      stepMode: body.stepMode === true,
      breakpoints: Array.isArray(body.breakpoints) ? body.breakpoints.map(String) : [],
      restore: { result, basedOn: { kind, from: relative(runsDir, file), throughStep } },
    })
  }

  function streamRun(req: IncomingMessage, res: ServerResponse, run: Run): void {
    sseHeaders(res)
    const lastId = Number(req.headers['last-event-id'] ?? -1)
    let closed = false
    const write = (m: (typeof run.messages)[number]) => {
      if (closed || m.seq <= lastId) return
      sse(res, m, m.seq)
      if (m.type === 'status' && TERMINAL.has(m.status)) {
        closed = true
        res.end()
      }
    }
    for (const m of [...run.messages]) write(m)
    if (closed) return
    const off = run.subscribe(write)
    res.on('close', () => {
      closed = true
      off()
    })
  }

  async function draft(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const request = typeof body.request === 'string' ? body.request.trim() : ''
    if (!request) return send(res, 400, { error: 'request is required' })
    const provider = providerFor(body.provider ?? 'scripted', body.model)
    const ctrl = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ctrl.abort()
    })
    sseHeaders(res)
    try {
      const out = await draftPattern(provider, request, {
        ...(body.priorDraft ? { priorDraft: body.priorDraft } : {}),
        ...(Array.isArray(body.feedback) ? { feedback: body.feedback.map(String) } : {}),
        signal: ctrl.signal,
        onEvent: (e) => sse(res, { type: 'provider', event: e }),
      })
      for (const r of out.rounds) sse(res, { type: 'round', round: r.round, errors: r.errors })
      sse(res, {
        type: 'done',
        ...(out.pattern ? { pattern: out.pattern, graph: patternToGraph(out.pattern) } : {}),
        rounds: out.rounds.length,
      })
    } catch (e) {
      sse(res, { type: 'error', error: (e as Error).message })
    } finally {
      await provider.dispose?.()
      res.end()
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (!path.startsWith('/api/')) return false
    const method = req.method ?? 'GET'
    const refused = method === 'POST' ? refuseCrossSite(req) : undefined
    if (refused) {
      send(res, 403, { error: refused })
      return true
    }
    try {
      if (method === 'GET' && path === '/api/patterns') {
        const asked = url.searchParams.get('extras')
        const items = await library(asked === 'on' || asked === 'off' ? asked : 'env')
        send(
          res,
          200,
          items.map(({ pattern, source }) => {
            const { demo, ...data } = pattern
            return {
              ...data,
              source,
              graph: patternToGraph(pattern),
              demo: demo ? { goal: demo.goal ?? '', context: demo.context ?? {} } : undefined,
            }
          }),
        )
        return true
      }
      if (method === 'POST' && path === '/api/validate') {
        const body = await readJson(req)
        const parsed = parseDraft(body.pattern)
        send(res, 200, parsed.ok ? validatePattern(parsed.value) : { errors: parsed.errors.map((message) => ({ message })), warnings: [] })
        return true
      }
      if (method === 'POST' && path === '/api/typescript') {
        send(res, 200, { source: patternToTypeScript(asPattern((await readJson(req)).pattern)) })
        return true
      }
      if (method === 'POST' && path === '/api/patterns') {
        const file = await savePatternFile(draftsDir, asPattern((await readJson(req)).pattern), '../../core/types.js')
        send(res, 200, { file })
        return true
      }
      if (method === 'POST' && path === '/api/draft') {
        await draft(await readJson(req), res)
        return true
      }
      if (method === 'POST' && path === '/api/runs') {
        const run = await startRun(await readJson(req))
        send(res, 200, { runId: run.id, score: run.score })
        return true
      }
      if (method === 'POST' && path === '/api/runs/continue') {
        const run = await continueRun(await readJson(req))
        send(res, 200, { runId: run.id, score: run.score })
        return true
      }
      if (method === 'GET' && path === '/api/runs') {
        // Newest first; every run this server started, so the studio can switch between them.
        send(res, 200, [...runs.values()].toReversed().map((r) => ({ id: r.id, pattern: r.score.pattern, goal: r.score.goal, status: r.status })))
        return true
      }
      if (method === 'GET' && path === '/api/copilot/status') {
        // Whether a GitHub account is signed in for Copilot here, so the studio can say how to fix it.
        const copilot = makeProvider({ provider: 'copilot', workingDirectory: workspace, ...envConfig(env) })
        try {
          const status = await (copilot as { authStatus?: () => Promise<unknown> }).authStatus?.()
          send(res, 200, status ?? { signedIn: true, message: '' })
        } catch (e) {
          send(res, 200, { signedIn: false, message: `Copilot could not start: ${(e as Error).message}` })
        } finally {
          await copilot.dispose?.()
        }
        return true
      }
      if (method === 'GET' && path === '/api/tiers') {
        send(res, 200, effectiveTiers(env))
        return true
      }
      const one = /^\/api\/runs\/([^/]+)$/.exec(path)
      if (one && method === 'GET') {
        const run = runs.get(one[1]!)
        if (!run) send(res, 404, { error: 'run not found' })
        else send(res, 200, { id: run.id, status: run.status, score: run.score, graph: patternToGraph(run.score) })
        return true
      }
      const m = /^\/api\/runs\/([^/]+)\/(events|control|approval|recovery)$/.exec(path)
      if (m) {
        const run = runs.get(m[1]!)
        if (!run) {
          send(res, 404, { error: 'run not found' })
          return true
        }
        if (m[2] === 'events' && method === 'GET') {
          streamRun(req, res, run)
          return true
        }
        const body = await readJson(req)
        if (m[2] === 'control') {
          switch (body.action) {
            case 'pause':
              run.pause()
              break
            case 'resume':
              run.resume()
              break
            case 'step':
              run.step()
              break
            case 'stop':
              run.stop()
              break
            case 'breakpoints':
              run.setBreakpoints(Array.isArray(body.breakpoints) ? body.breakpoints.map(String) : [])
              break
            case 'stepMode':
              run.setStepMode(body.on === true)
              break
            default:
              send(res, 400, { error: `unknown action '${String(body.action)}'` })
              return true
          }
          send(res, 200, { status: run.status })
          return true
        }
        if (m[2] === 'recovery') {
          if (body.action !== 'retry' && body.action !== 'stop') {
            send(res, 400, { error: 'action must be retry or stop' })
            return true
          }
          const complexity = [1, 2, 3, 4].includes(body.complexity as number) ? (body.complexity as Complexity) : undefined
          const error = run.answerRecovery({
            action: body.action,
            ...(typeof body.hint === 'string' && body.hint.trim() ? { hint: body.hint.trim().slice(0, 2000) } : {}),
            ...(complexity ? { complexity } : {}),
            by: 'studio',
          })
          send(res, error ? 409 : 200, error ? { error } : { ok: true })
          return true
        }
        const error = run.answerApproval({
          approved: body.approved !== false,
          ...(body.updates && typeof body.updates === 'object' ? { updates: body.updates as Record<string, unknown> } : {}),
          scripted: body.scripted === true,
          by: 'studio',
        })
        send(res, error ? 409 : 200, error ? { error } : { ok: true })
        return true
      }
      if (method === 'GET' && path === '/api/saved') {
        send(res, 200, await listRuns(runsDir))
        return true
      }
      if (method === 'POST' && path === '/api/saved/prune') {
        const body = await readJson(req)
        send(res, 200, await pruneRuns(runsDir, { scratchDir, dryRun: body.dryRun === true }))
        return true
      }
      if (method === 'POST' && path === '/api/saved/delete') {
        const body = await readJson(req)
        const file = runPath(runsDir, typeof body.path === 'string' ? body.path : '')
        if (!file) {
          send(res, 400, { error: 'invalid path' })
          return true
        }
        const playing = [...savedFiles].find(([id, f]) => f === file && !TERMINAL.has(runs.get(id)?.status ?? 'done'))
        if (playing) {
          send(res, 409, { error: 'this run is still playing: stop it first' })
          return true
        }
        if (!(await deleteRun(runsDir, file))) {
          send(res, 404, { error: 'no such saved run' })
          return true
        }
        send(res, 200, { deleted: file })
        return true
      }
      if (method === 'GET' && path === '/api/saved/file') {
        const file = runPath(runsDir, url.searchParams.get('path') ?? '')
        if (!file) {
          send(res, 400, { error: 'invalid path' })
          return true
        }
        const { run, issues, migrated } = await loadRun(file)
        const reproduced = issues.length === 0 && replayPerformance(run.score, run.performance).divergence.reproduced
        // When a replay diverges, say whether a different engine version recorded it.
        const engine = !reproduced && issues.length === 0 ? engineNote(run.performance.engine) : undefined
        send(res, 200, {
          run,
          issues: engine ? [...issues, engine] : issues,
          reproduced,
          migrated,
          graph: patternToGraph(run.score),
        })
        return true
      }
      send(res, 404, { error: 'not found' })
      return true
    } catch (e) {
      if (e instanceof CompileError) send(res, 400, { error: e.message, issues: e.issues })
      else send(res, 500, { error: (e as Error).message })
      return true
    }
  }

  return { handle, runs }
}
