/**
 * Studio API: REST + Server-Sent Events over the deterministic runtime.
 *
 *   GET  /api/patterns                     library (built-in + drafts) as graphs
 *   POST /api/validate        {pattern}    static validation
 *   POST /api/typescript      {pattern}    TypeScript source for a pattern
 *   POST /api/patterns        {pattern}    save as src/patterns/drafts/<name>.ts
 *   POST /api/draft           {request}    AI drafts a pattern (SSE stream)
 *   POST /api/runs            {pattern, goal, context, provider, ...} -> { runId, score }
 *   GET  /api/runs                         active runs
 *   GET  /api/runs/:id/events              SSE: engine + provider + status messages
 *   POST /api/runs/:id/control {action}    pause | resume | step | stop | breakpoints | stepMode
 *   POST /api/runs/:id/approval {approved, updates, scripted}
 *   GET  /api/saved                        saved runs
 *   GET  /api/saved/file?path=             saved run + integrity + replay check
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { CompileError, compileScore } from '../../../src/core/compile.js'
import { parseDraft, patternToTypeScript } from '../../../src/core/draft.js'
import { patternToGraph } from '../../../src/core/graph.js'
import { replayPerformance } from '../../../src/core/replay.js'
import type { Pattern } from '../../../src/core/types.js'
import { validatePattern } from '../../../src/core/validate.js'
import { PATTERNS } from '../../../src/patterns/index.js'
import { draftPattern } from '../../../src/runtime/drafting.js'
import { Run } from '../../../src/runtime/driver.js'
import { envConfig, isProviderName, makeProvider, runtimeExtras, type RuntimeExtras } from '../../../src/runtime/factory.js'
import { gitFingerprint, listRuns, loadPatternFiles, loadRun, runPath, savePatternFile, saveRun } from '../../../src/runtime/store.js'

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
}

export const RUNS_DIR = '.symphony/runs'
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
  const runs = new Map<string, Run>()
  const env = opts.env ?? process.env
  const workspace = opts.workspace ?? opts.repoRoot
  const runsDir = join(opts.repoRoot, RUNS_DIR)
  const draftsDir = join(opts.repoRoot, DRAFTS_DIR)

  async function library(): Promise<{ pattern: Pattern; source: 'builtin' | 'draft' }[]> {
    const drafts = await loadPatternFiles(draftsDir, opts.importer)
    return [
      ...PATTERNS.map((pattern) => ({ pattern, source: 'builtin' as const })),
      ...drafts
        .filter((d) => !PATTERNS.some((p) => p.name === d.name))
        .map((pattern) => ({ pattern, source: 'draft' as const })),
    ]
  }

  async function demoFor(name: string) {
    return (await library()).find((l) => l.pattern.name === name)?.pattern.demo
  }

  let extras: Promise<RuntimeExtras> | undefined
  const runtime = () => (extras ??= runtimeExtras(workspace, opts.repoRoot, env))

  function providerFor(name: unknown, model: unknown, pattern?: Pattern, mcpServers?: RuntimeExtras['mcpServers']) {
    if (!isProviderName(name)) throw new CompileError([{ message: 'provider must be scripted or copilot' }])
    return makeProvider({
      provider: name,
      ...(pattern ? { pattern } : {}),
      workingDirectory: workspace,
      delayMs: opts.scriptedDelayMs ?? 0,
      ...(mcpServers ? { mcpServers } : {}),
      ...envConfig(env),
      ...(typeof model === 'string' && model ? { model } : {}),
    })
  }

  async function startRun(body: Record<string, unknown>): Promise<Run> {
    const pattern = asPattern(body.pattern)
    const demo = await demoFor(pattern.name)
    const withDemo: Pattern = demo ? { ...pattern, demo } : pattern
    const score = compileScore(withDemo, {
      goal: typeof body.goal === 'string' && body.goal.trim() ? body.goal : pattern.description || pattern.name,
      context: (body.context as Record<string, unknown> | undefined) ?? {},
    })
    const { tools, toolContext, mcpServers } = await runtime()
    const provider = providerFor(body.provider ?? 'scripted', body.model, withDemo, mcpServers)
    const run = new Run({
      score,
      provider,
      tools,
      toolContext,
      ...(demo ? { demo } : {}),
      autoApprove: body.autoApprove === true,
      stepMode: body.stepMode === true,
      breakpoints: Array.isArray(body.breakpoints) ? body.breakpoints.map(String) : [],
      ...(provider.name === 'copilot' ? { envHash: () => gitFingerprint(workspace) } : {}),
      onSave: (r) => saveRun(runsDir, r),
    })
    runs.set(run.id, run)
    void run.start().finally(() => provider.dispose?.())
    return run
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
        const items = await library()
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
      if (method === 'GET' && path === '/api/runs') {
        send(res, 200, [...runs.values()].map((r) => ({ id: r.id, pattern: r.score.pattern, status: r.status })))
        return true
      }
      const m = /^\/api\/runs\/([^/]+)\/(events|control|approval)$/.exec(path)
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
      if (method === 'GET' && path === '/api/saved/file') {
        const file = runPath(runsDir, url.searchParams.get('path') ?? '')
        if (!file) {
          send(res, 400, { error: 'invalid path' })
          return true
        }
        const { run, issues } = await loadRun(file)
        const reproduced = issues.length === 0 && replayPerformance(run.score, run.performance).divergence.reproduced
        send(res, 200, { run, issues, reproduced, graph: patternToGraph(run.score) })
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
