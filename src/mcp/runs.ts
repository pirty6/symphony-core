/**
 * Runs started through MCP (VS Code agents, Copilot Studio). Long pipelines
 * do not fit in one tool call, so a run starts in the background and the
 * caller polls it: what it is doing, what it is waiting for (an approval, a
 * stuck step), and its result. Humans answer through the chat.
 */
import { summarizeComposed } from '../core/draft.js';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ChainStep, resultText } from '../core/chain.js';
import { compileScore } from '../core/compile.js';
import { playsFromRepertoire } from '../core/jazz.js';
import { zeroValue } from '../core/schema.js';
import {
  addUsage,
  callPhases,
  costliest,
  growth,
  formatPhases,
  formatUsage,
  formatWaits,
  humanWaits,
  performanceUsage,
  rejectionUsage,
} from '../core/usage.js';
import type { Performance, TokenUsage } from '../core/types.js';
import { describeEdits } from '../core/edits.js';
import type {
  Complexity,
  EngineEvent,
  ExecutableScore,
  Improvisation,
  Pattern,
} from '../core/types.js';
import { libraryPatterns } from '../patterns/index.js';
import { chainNext } from '../runtime/chain.js';
import { concertNext } from '../runtime/concert.js';
import { Run, type RunOptions } from '../runtime/driver.js';
import {
  claimLive,
  liveRoot,
  noteLive,
  publishLive,
  readLiveEntry,
  type LiveResume,
} from '../runtime/live.js';
import { restoreEngine } from '../core/replay.js';
import type { Provider } from '../runtime/provider.js';
import { envConfig, makeProvider, runtimeExtras, type ProviderName } from '../runtime/factory.js';
import {
  autoPrune,
  gitFingerprint,
  loadRun,
  runScratch,
  loadPatternFiles,
  loadRepertoire,
  runsDirFor,
  saveRun,
} from '../runtime/store.js';
import { editsFiles, isolate, sandboxFor } from '../runtime/worktree.js';
import { prForRun } from '../runtime/pr.js';

const DRAFTS_DIR = 'src/patterns/drafts';

export { editsFiles };

/** Every AI step plays with read-only (assessor) permissions. */
export function readOnly(provider: Provider): Provider {
  return {
    name: provider.name,
    runAgent: (req) => provider.runAgent({ ...req, pause: { ...req.pause, role: 'assessor' } }),
    draft: (req) => provider.draft(req),
    ...(provider.dispose ? { dispose: () => provider.dispose!() } : {}),
  };
}

const tailored = (a: unknown): boolean =>
  typeof a === 'object' &&
  a !== null &&
  Object.values(a).some((x) => Object.keys(x ?? {}).length > 0);

/** What the maestro composed, compact enough to show in a chat at its go-gate. */
function composedSummary(state: Readonly<Record<string, unknown>>) {
  const p = state.normalized as
    | { name?: string; description?: string; nodes?: { id: string; label: string; kind: string }[] }
    | undefined;
  if (!p?.nodes) return undefined;
  const summary = summarizeComposed(state);
  const fresh = summary?.kind === 'new' || summary?.kind === 'rewritten';
  return {
    pattern: p.name,
    // "the tested library pattern (67 steps), with guidance on 13 AI steps" vs a new one.
    summary: summary?.headline,
    kind: summary?.kind,
    description: p.description,
    // A tested library pattern's steps are known: list them only when they are new.
    ...(fresh || !summary
      ? { steps: p.nodes.filter((n) => n.kind !== 'start').map((n) => `${n.id}: ${n.label}`) }
      : { stepCount: summary.steps }),
    // How the tested library pattern was tailored (empty for new or rewritten scores).
    ...(tailored(state.adaptation) ? { adaptation: state.adaptation } : {}),
    inputs: state.childContext,
    // How each requirement (the request's, then every feedback) is met, and any that are not.
    requirements: state.coverage,
    ...((state.uncovered as unknown[] | undefined)?.length ? { notCovered: state.uncovered } : {}),
    debateNotes: state.debateNotes,
    missingInputs: state.contextNotes,
    thenPattern: state.thenPattern || undefined,
  };
}

export interface RunManagerOptions {
  /** Folder the pipeline works in (MCP roots, SYMPHONY_WORKSPACE or cwd). */
  readonly workspace: () => Promise<string>;
  /** symphony-core checkout (drafted patterns). */
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  /** False for remote (HTTP) callers unless SYMPHONY_ALLOW_EDITS=1. */
  readonly editsAllowed: boolean;
}

export interface StartRequest {
  readonly pattern: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly chain?: readonly string[];
  readonly provider?: ProviderName;
  readonly complexity?: Complexity;
  readonly improvisation?: Improvisation;
  readonly autoApprove?: boolean;
  /** A folder to work in instead of the client's workspace root (e.g. a separate worktree). */
  readonly workspace?: string;
}

interface Managed {
  readonly run: Run;
  readonly pattern: Pattern;
  next?: string;
  /** Why a hand-off did not start (e.g. the composed score edits files over HTTP). */
  blocked?: string;
  /** Picked up from its last checkpoint after the server that played it ended. */
  resumed?: string;
  savedTo?: string;
  /** The approval a get_run first returned, and when: the gate wait splits there. */
  shown?: { readonly pauseId: string; readonly at: string };
}

export type Waiting =
  | {
      readonly kind: 'approval';
      readonly step: string;
      readonly message: string;
      readonly shows: Readonly<Record<string, unknown>>;
      readonly fields: readonly { readonly name: string; readonly type: string }[];
    }
  | {
      readonly kind: 'stuck';
      readonly step: string;
      readonly feedback: readonly string[];
      readonly attempts: number;
      readonly complexity: Complexity;
    }
  | {
      readonly kind: 'overtime';
      readonly step: string;
      readonly message: string;
      /** How long the step has run (minutes). */
      readonly minutes: number;
    };

export interface Usage {
  readonly premiumRequests?: number;
  /** Costliest steps of this run first. */
  readonly byStep: Readonly<Record<string, string>>;
  /** Attempts thrown away and what they cost, and answers that sent updates as text. */
  readonly rejected?: string;
  /** Model time by what the calls were for (answer, correction, closing…). */
  readonly modelTime?: string;
  /** submit_result calls corrected inside a session (engine attempts never count them). */
  readonly inSessionCorrections?: number;
  /** Each approval's wait for a person, apart from the pipeline's own time. */
  readonly waits?: readonly string[];
  /** The whole chain (maestro -> composed -> chained): composing apart from performing. */
  readonly chain?: {
    readonly compose: string;
    readonly perform: string;
    readonly premiumRequests: number;
  };
}

const NONE: TokenUsage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
};

type Steps = { readonly steps: Performance['steps'] };

/**
 * Usage of the run shown, measured: its costliest steps (rejected attempts included),
 * what rejected answers cost, and, for a chain, composing (maestro) apart from performing.
 */
export function usageOf(
  latest: Steps,
  chain: readonly ({ readonly pattern: string } & Steps)[],
): Usage {
  const mine = performanceUsage(latest);
  const rejected = rejectionUsage(latest);
  const phases = callPhases(latest);
  const waits = formatWaits(chain.flatMap((r) => humanWaits(r)));
  let compose = NONE;
  let perform = NONE;
  for (const r of chain) {
    const u = performanceUsage(r).total;
    if (r.pattern === 'maestro') compose = addUsage(compose, u);
    else perform = addUsage(perform, u);
  }
  return {
    ...(mine.total.premiumRequests ? { premiumRequests: mine.total.premiumRequests } : {}),
    byStep: Object.fromEntries(costliest(mine.byNode).map((t) => [t.node, t.text])),
    // Steps whose input grows visit by visit: where re-sent context piles up.
    ...(growth(mine.byVisit).length ? { growing: growth(mine.byVisit) } : {}),
    ...(rejected.attempts || rejected.textUpdates
      ? {
          rejected: `${rejected.attempts} attempts (${formatUsage(rejected.attemptUsage)})${rejected.textUpdates ? ` · ${rejected.textUpdates} answers sent updates as text` : ''}`,
        }
      : {}),
    ...(Object.keys(phases.total).length ? { modelTime: formatPhases(phases.total) } : {}),
    ...(phases.corrections ? { inSessionCorrections: phases.corrections } : {}),
    ...(waits.length ? { waits } : {}),
    ...(chain.length > 1
      ? {
          chain: {
            compose: formatUsage(compose),
            perform: formatUsage(perform),
            premiumRequests: (compose.premiumRequests ?? 0) + (perform.premiumRequests ?? 0),
          },
        }
      : {}),
  };
}

export interface RunView {
  /** The run being shown: the latest one when a run handed on to another. */
  readonly runId: string;
  /** Runs from the first to this one (maestro -> composed score -> chained…). */
  readonly chain: readonly string[];
  readonly pattern: string;
  readonly status: string;
  readonly step: number;
  readonly activeStep?: string;
  readonly waitingFor?: Waiting;
  /** Approvals answer themselves (set at the start, or turned on mid-run). */
  readonly autoApprove?: true;
  /** The last engine events, one line each. */
  readonly recent: readonly string[];
  readonly outcome?: string;
  readonly reason?: string;
  /** The run's declared result as Markdown, when it ended. */
  readonly result?: string;
  readonly savedTo?: string;
  readonly note?: string;
  /** Tokens the AI steps of this run spent so far. */
  readonly tokens?: string;
  /** What the AI spent, measured: this run's costliest steps, rejected answers, the whole chain. */
  readonly usage?: Usage;
  /** Where the file edits went (the run played in its own worktree). */
  readonly edits?: string;
}

const ACTIVE = new Set(['running', 'paused', 'awaiting-approval']);
/** How long stop_run waits for the current step to end before answering. */
const STOP_WAIT_MS = 15_000;
/** Hand-offs followed to find where a chain is now (a maestro, its run, a chain, resumes). */
const MAX_HOPS = 20;

function overtimeWaiting(
  over: { readonly nodeId: string; readonly afterMs: number },
  score: ExecutableScore,
): Waiting {
  const minutes = Math.round(over.afterMs / 60_000);
  const step = score.nodes.find((n) => n.id === over.nodeId)?.label ?? over.nodeId;
  return {
    kind: 'overtime',
    step,
    minutes,
    message: `'${step}' has run ${minutes} min, its time limit, and is still working. Keep waiting (asked again after another limit), or stop the step: an answer it already submitted is kept; with none, it counts as a failed attempt and is retried.`,
  };
}

function describe(e: EngineEvent): string | undefined {
  switch (e.type) {
    case 'node-entered':
      return `#${e.step} ${e.nodeId}`;
    case 'response-rejected':
      return `rejected ${e.nodeId}: ${e.errors[0] ?? ''}`;
    case 'node-completed':
      return e.changes.length
        ? `${e.nodeId} set ${e.changes.map((c) => c.key).join(', ')}`
        : undefined;
    case 'paused':
      return e.pause.kind === 'stuck'
        ? `${e.pause.nodeId} stuck after ${e.pause.attempts} attempts`
        : e.pause.kind === 'approval'
          ? `${e.pause.nodeId} waits for a human`
          : undefined;
    case 'recovered':
      return `${e.nodeId}: ${e.recovery.action}${e.recovery.hint ? ` ("${e.recovery.hint}")` : ''}`;
    case 'run-completed':
      return `${e.outcome}: ${e.reason}`;
    case 'run-failed':
      return `failed: ${e.error}`;
    default:
      return undefined;
  }
}

export class RunManager {
  private readonly runs = new Map<string, Managed>();
  /** Runs another server played, by the id the chat knows, to the run that resumed them. */
  private readonly aliases = new Map<string, string>();
  private readonly adopting = new Map<string, Promise<void>>();
  private readonly opts: RunManagerOptions;
  constructor(opts: RunManagerOptions) {
    this.opts = opts;
  }

  async library(): Promise<Pattern[]> {
    const drafts = await loadPatternFiles(
      join(this.opts.repoRoot, DRAFTS_DIR),
      (f) => import(pathToFileURL(f).href),
    ).catch(() => [] as Pattern[]);
    return libraryPatterns(this.opts.env, drafts);
  }

  get editsAllowed(): boolean {
    return this.opts.editsAllowed;
  }

  private refuseEdits(p: Pattern): string | undefined {
    return !this.opts.editsAllowed && editsFiles(p)
      ? `'${p.name}' edits files, which remote callers may not do. Run it from VS Code, or start the HTTP server with SYMPHONY_ALLOW_EDITS=1.`
      : undefined;
  }

  /** Compile and start a pattern; returns the run id. Throws with a readable message. */
  async start(req: StartRequest): Promise<string> {
    if (req.workspace !== undefined) await this.checkWorkspace(req.workspace);
    const lib = await this.library();
    const pattern = lib.find((p) => p.name === req.pattern);
    if (!pattern) throw new Error(`unknown pattern '${req.pattern}'`);
    const refused = this.refuseEdits(pattern);
    if (refused) throw new Error(refused);
    for (const name of req.chain ?? []) {
      const next = lib.find((p) => p.name === name);
      if (!next) throw new Error(`unknown pattern '${name}' in chain`);
      const no = this.refuseEdits(next);
      if (no) throw new Error(no);
    }
    const score = compileScore(pattern, {
      goal: pattern.description,
      context: req.inputs ?? {},
      ...(req.complexity ? { complexity: req.complexity } : {}),
      ...(req.improvisation !== undefined ? { improvisation: req.improvisation } : {}),
    });
    return this.launch(score, pattern, req, req.chain ?? []);
  }

  /** A chosen folder: local callers only, and it must be an existing folder. */
  private async checkWorkspace(dir: string): Promise<void> {
    if (!this.opts.editsAllowed)
      throw new Error(
        'workspace can only be chosen from a local chat (VS Code), not by remote callers.',
      );
    if (!isAbsolute(dir)) throw new Error(`workspace must be an absolute path, got '${dir}'`);
    const st = await stat(dir).catch(() => undefined);
    if (!st?.isDirectory()) throw new Error(`workspace '${dir}' is not a folder on this machine`);
  }

  private async launch(
    score: ExecutableScore,
    pattern: Pattern,
    req: StartRequest,
    chain: readonly ChainStep[],
    restore?: RunOptions['restore'],
  ): Promise<string> {
    const workspace = req.workspace ?? (await this.opts.workspace());
    const runsDir = runsDirFor(workspace, this.opts.env);
    void autoPrune(workspace, runsDir, this.opts.env);
    const extras = await runtimeExtras(workspace, this.opts.repoRoot, this.opts.env);
    const providerName = req.provider ?? 'copilot';
    // A real AI editing files plays in its own worktree, so several can play at once.
    const isolation =
      providerName === 'copilot' && this.opts.editsAllowed && editsFiles(score)
        ? await isolate(workspace, score.pattern, this.opts.env)
        : undefined;
    // A run that reads a PR plays on the PR's own code, checked out apart (runtime/pr.ts).
    const pr = isolation
      ? undefined
      : await prForRun(pattern, score.context, workspace, {
          provider: providerName,
          env: this.opts.env,
        });
    const dir = isolation?.dir ?? pr?.dir ?? workspace;
    const base = makeProvider({
      provider: providerName,
      pattern,
      workingDirectory: dir,
      mcpServers: extras.mcpServers,
      ...envConfig(this.opts.env),
    });
    const provider = this.opts.editsAllowed ? base : readOnly(base);
    let managed: Managed | undefined;
    // A hand-off that may not start leaves a note instead of failing the finished run.
    const handOff = async (s: ExecutableScore, p: Pattern, rest: readonly ChainStep[]) => {
      const refused = this.refuseEdits(p);
      if (refused) {
        if (managed) managed.blocked = refused;
        throw new Error(refused);
      }
      // It plays with auto-approve as it is now: turned on mid-run, the next run keeps it.
      const id = await this.launch(
        s,
        p,
        { ...req, autoApprove: managed?.run.autoApproves ?? req.autoApprove === true },
        rest,
      );
      if (managed) {
        managed.next = id;
        await this.note(managed.run.id, { next: id });
      }
      return id;
    };
    const next =
      concertNext({ maestroScore: score, start: handOff }) ??
      chainNext({ chain, score, library: () => this.library(), start: handOff });
    // Until the run owns the PR checkout (cleanup), a failure here must remove it.
    let run: Run;
    try {
      run = new Run({
        score,
        provider,
        tools: extras.tools,
        toolContext: {
          ...extras.toolContext,
          ...(dir !== workspace
            ? { workspace: dir, memoryRoot: extras.toolContext.workspace }
            : {}),
          ...(pr ? { pr: pr.info } : {}),
          // Remote callers read only: no command (tests, lint) runs on this machine for them.
          ...(this.opts.editsAllowed ? {} : { runsCode: false }),
        },
        ...(pattern.demo ? { demo: pattern.demo } : {}),
        ...(playsFromRepertoire(score.improvisation)
          ? { repertoire: await loadRepertoire(runsDir, score.id) }
          : {}),
        autoApprove: req.autoApprove === true,
        // Someone relays the run: at the time limit, ask them rather than cut the step off.
        askOnOvertime: req.autoApprove !== true,
        ...(providerName === 'copilot'
          ? {
              envHash: () => gitFingerprint(dir),
              scratch: await runScratch(workspace),
              sandbox: sandboxFor(dir),
            }
          : {}),
        ...(isolation ? { isolation } : {}),
        ...(pr ? { cleanup: pr.finish } : {}),
        checkpoint: true,
        onSave: async (r, how) => {
          const file = await saveRun(runsDir, r, { compact: how?.checkpoint === true });
          if (managed && managed.savedTo !== file) {
            managed.savedTo = file;
            void this.note(managed.run.id, { savedTo: file });
          }
          return file;
        },
        ...(restore ? { restore } : {}),
        ...(next ? { next } : {}),
      });
    } catch (e) {
      await pr?.finish();
      throw e;
    }
    managed = { run, pattern };
    this.runs.set(run.id, managed);
    // The studio shows the chat's runs live and can steer them (src/runtime/live.ts).
    const live = liveRoot(this.opts.env);
    const published = live
      ? publishLive(run, { source: 'chat', workspace }, live).catch(() => undefined)
      : undefined;
    // Published before it starts, so the studio sees it from its first message.
    await published;
    await this.note(run.id, {
      provider: providerName,
      autoApprove: req.autoApprove === true,
      chain,
    });
    void run.start().finally(() => provider.dispose?.());
    return run.id;
  }

  private get(runId: string): Managed {
    const m = this.runs.get(this.aliases.get(runId) ?? runId);
    if (!m) throw new Error(`unknown run '${runId}'`);
    return m;
  }

  private note(id: string, patch: LiveResume): Promise<void> {
    const root = liveRoot(this.opts.env);
    return root ? noteLive(root, id, patch) : Promise.resolve();
  }

  /**
   * A run this server does not play, by an id a chat knows: when the server that played it ended
   * mid-run (a restarted chat ends its MCP server), resume it from its last checkpoint here.
   */
  private async ensure(runId: string): Promise<void> {
    if (this.runs.has(runId) || this.aliases.has(runId)) return;
    const pending =
      this.adopting.get(runId) ?? this.adopt(runId).finally(() => this.adopting.delete(runId));
    this.adopting.set(runId, pending);
    await pending;
  }

  private async adopt(runId: string): Promise<void> {
    const root = liveRoot(this.opts.env);
    if (!root) return;
    let id = runId;
    let entry = await readLiveEntry(root, id);
    // Follow hand-offs (and earlier resumes) to the run the chain is on now.
    for (let hops = 0; entry?.resume.next && hops < MAX_HOPS; hops++) {
      const next = entry.resume.next;
      if (this.runs.has(next)) {
        this.aliases.set(runId, next);
        return;
      }
      id = next;
      entry = await readLiveEntry(root, id);
    }
    if (!entry) return;
    const record = entry.resume.savedTo ? `; its record: ${entry.resume.savedTo}` : '';
    if (entry.playing)
      throw new Error(
        `run '${runId}' is played by another Symphony process (pid ${entry.meta.pid}), e.g. another chat's: follow it there or in the studio`,
      );
    if (entry.status === 'done' || entry.status === 'failed')
      throw new Error(`run '${runId}' ended (${entry.status}) before this server started${record}`);
    if (!this.opts.editsAllowed)
      throw new Error(
        `run '${runId}' stopped when the Symphony server playing it ended; only a local chat can resume it${record}`,
      );
    const file = entry.resume.savedTo;
    if (!file)
      throw new Error(
        `run '${runId}' stopped when the Symphony server playing it ended, before its first checkpoint: start it again`,
      );
    if (!(await claimLive(root, id)))
      throw new Error(`run '${runId}' is being resumed by another Symphony process`);
    const { run: saved, issues } = await loadRun(file);
    if (issues.length) throw new Error(`cannot resume run '${runId}': ${issues.join('; ')}`);
    const perf = saved.performance;
    if (perf.outcome !== 'in-progress' && perf.outcome !== 'cancelled')
      throw new Error(`run '${runId}' ended (${perf.outcome})${record}`);
    const throughStep = perf.steps.at(-1)?.step ?? 0;
    const pattern = (await this.library()).find((p) => p.name === saved.score.pattern) ?? {
      name: saved.score.pattern,
      description: saved.score.description,
      requiredContext: [],
      state: saved.score.state,
      nodes: saved.score.nodes,
      edges: saved.score.edges,
      start: saved.score.start,
    };
    const resumed = await this.launch(
      saved.score,
      pattern,
      {
        pattern: pattern.name,
        provider: (entry.resume.provider as ProviderName | undefined) ?? 'copilot',
        autoApprove: entry.resume.autoApprove === true,
        workspace: entry.meta.workspace,
      },
      entry.resume.chain ?? [],
      {
        result: restoreEngine(saved.score, perf),
        basedOn: { kind: 'resumed', from: file, throughStep },
      },
    );
    await this.note(id, { next: resumed });
    this.aliases.set(runId, resumed);
    this.aliases.set(id, resumed);
    const managed = this.runs.get(resumed);
    if (managed)
      managed.resumed = `The Symphony server playing this run ended (e.g. the chat restarted it); resumed here from its last checkpoint: steps 1..${throughStep} replayed from the record, the rest played again.`;
  }

  /** Follow hand-offs to the latest run of a chain. */
  private latest(runId: string): { managed: Managed; id: string; chain: string[] } {
    let id = this.aliases.get(runId) ?? runId;
    const chain = [id];
    let managed = this.get(id);
    while (managed.next && this.runs.has(managed.next)) {
      id = managed.next;
      chain.push(id);
      managed = this.get(id);
    }
    return { managed, id, chain };
  }

  view(runId: string): RunView {
    const { managed, id, chain } = this.latest(runId);
    const { run, pattern } = managed;
    const engine = run.engine;
    const pause = engine?.pause;
    const recent = (engine?.events ?? []).flatMap((e) => describe(e) ?? []).slice(-12);
    const human = run.status === 'awaiting-approval';
    const waitingFor: Waiting | undefined =
      human && pause?.kind === 'approval'
        ? {
            kind: 'approval',
            step: pause.label,
            message: pause.message,
            shows: {
              ...Object.fromEntries(pause.shows.map((k) => [k, pause.state[k]])),
              ...(composedSummary(pause.state) ? { composed: composedSummary(pause.state) } : {}),
            },
            fields: pause.outputSchema.map((f) => ({ name: f.name, type: f.type })),
          }
        : human && pause?.kind === 'stuck'
          ? {
              kind: 'stuck',
              step: pause.label,
              feedback: pause.feedback,
              attempts: pause.attempts,
              complexity: pause.complexity,
            }
          : run.overtime
            ? overtimeWaiting(run.overtime, run.score)
            : undefined;
    const ended = !ACTIVE.has(run.status) && engine !== undefined && engine.kind !== 'running';
    const result = ended ? resultText(run.score, engine.state) : '';
    const active = pause?.nodeId ?? engine?.cursor;
    const used = performanceUsage(engine ?? { steps: [] }).total;
    const final = run.messages.findLast((m) => m.type === 'performance');
    const edits = final?.type === 'performance' ? final.performance.edits : undefined;
    return {
      runId: id,
      chain,
      pattern: pattern.name,
      status: run.status,
      step: engine?.step ?? 0,
      ...(active && ACTIVE.has(run.status) ? { activeStep: active } : {}),
      ...(waitingFor ? { waitingFor } : {}),
      ...(run.autoApproves ? { autoApprove: true } : {}),
      recent,
      ...(ended ? { outcome: engine.outcome } : {}),
      ...(ended && engine.reason ? { reason: engine.reason } : {}),
      ...(result ? { result } : {}),
      ...(managed.savedTo ? { savedTo: managed.savedTo } : {}),
      ...(managed.blocked || managed.resumed ? { note: managed.blocked ?? managed.resumed } : {}),
      ...(used.calls > 0 ? { tokens: formatUsage(used), usage: this.usage(engine, chain) } : {}),
      ...(edits ? { edits: describeEdits(edits) } : {}),
    };
  }

  private usage(engine: { readonly steps: Performance['steps'] }, chain: readonly string[]): Usage {
    const runs = chain.flatMap((id) => {
      const r = this.runs.get(id)?.run;
      return r?.engine ? [{ pattern: r.score.pattern, steps: r.engine.steps }] : [];
    });
    return usageOf(engine, runs);
  }

  /** Settled: needs a human, or ended without handing on. */
  private settled(runId: string): boolean {
    const v = this.view(runId);
    return (
      v.waitingFor !== undefined || (!ACTIVE.has(v.status) && !this.latest(runId).managed.next)
    );
  }

  /**
   * Wait until the run needs a human or ends (following hand-offs), or until
   * `seconds` pass; then return its view. Short waits keep each tool call quick.
   */
  async wait(runId: string, seconds: number): Promise<RunView> {
    await this.ensure(runId);
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    while (!this.settled(runId) && Date.now() < deadline) {
      const { managed } = this.latest(runId);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        const off = managed.run.subscribe((m) => {
          if (
            m.type === 'next' ||
            (m.type === 'overtime' && m.state === 'asking') ||
            (m.type === 'status' && m.status !== 'running')
          )
            finish();
        });
        function finish() {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    }
    const v = this.view(runId);
    const { managed } = this.latest(runId);
    const pause = managed.run.engine?.pause;
    if (v.waitingFor?.kind === 'approval' && pause && managed.shown?.pauseId !== pause.pauseId)
      managed.shown = { pauseId: pause.pauseId, at: new Date().toISOString() };
    return v;
  }

  async answerApproval(
    runId: string,
    answer: { approved: boolean; updates?: Record<string, unknown> },
  ): Promise<RunView> {
    await this.ensure(runId);
    const { managed, id } = this.latest(runId);
    const pause = managed.run.engine?.pause;
    // Fields left out are empty, as in the studio (e.g. the maestro's "empty feedback = go").
    const updates =
      pause?.kind === 'approval'
        ? Object.fromEntries(
            pause.outputSchema.map((f) => [f.name, answer.updates?.[f.name] ?? zeroValue(f.type)]),
          )
        : answer.updates;
    const shownAt = managed.shown?.pauseId === pause?.pauseId ? managed.shown?.at : undefined;
    const error = managed.run.answerApproval({
      approved: answer.approved,
      ...(updates ? { updates } : {}),
      by: 'mcp',
      ...(shownAt ? { shownAt } : {}),
    });
    if (error) throw new Error(error);
    return this.view(id);
  }

  async answerStuck(
    runId: string,
    answer: { action: 'retry' | 'stop'; hint?: string; complexity?: Complexity },
  ): Promise<RunView> {
    await this.ensure(runId);
    const { managed, id } = this.latest(runId);
    const error = managed.run.answerRecovery({ ...answer, by: 'mcp' });
    if (error) throw new Error(error);
    return this.view(id);
  }

  /** A step over its time limit (waitingFor.kind = 'overtime'): keep waiting, or stop the step. */
  async answerOvertime(runId: string, action: 'wait' | 'stop'): Promise<RunView> {
    await this.ensure(runId);
    const { managed, id } = this.latest(runId);
    const error = managed.run.answerOvertime(action);
    if (error) throw new Error(error);
    return this.view(id);
  }

  /**
   * Stop the latest run of the chain (any run id of it works), then wait up to
   * `waitMs` for its current step to wind down: answering "running" right after
   * a stop made callers think it had not stopped. Still ending: 'stopping'.
   */
  /**
   * Approvals answer themselves from now on (the one waiting included), in this run and the
   * runs it hands on to; or ask again. Stuck steps still ask. Any run id of a chain works.
   */
  async setAutoApprove(runId: string, on: boolean): Promise<RunView> {
    await this.ensure(runId);
    const { managed, id } = this.latest(runId);
    managed.run.setAutoApprove(on);
    await this.note(id, { autoApprove: on });
    return this.view(id);
  }

  async stop(runId: string, waitMs = STOP_WAIT_MS): Promise<RunView> {
    const { managed, id } = this.latest(runId);
    managed.run.stop('stopped from chat');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      managed.run.start().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
    const view = this.view(id);
    return ACTIVE.has(view.status) ? { ...view, status: 'stopping' } : view;
  }
}
