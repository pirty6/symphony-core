/**
 * Runs started through MCP (VS Code agents, Copilot Studio). Long pipelines
 * do not fit in one tool call, so a run starts in the background and the
 * caller polls it: what it is doing, what it is waiting for (an approval, a
 * stuck step), and its result. Humans answer through the chat.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ChainStep, resultText } from '../core/chain.js';
import { compileScore } from '../core/compile.js';
import { playsFromRepertoire } from '../core/jazz.js';
import { zeroValue } from '../core/schema.js';
import { formatUsage, performanceUsage } from '../core/usage.js';
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
import { Run } from '../runtime/driver.js';
import type { Provider } from '../runtime/provider.js';
import { envConfig, makeProvider, runtimeExtras, type ProviderName } from '../runtime/factory.js';
import {
  autoPrune,
  gitFingerprint,
  runScratch,
  loadPatternFiles,
  loadRepertoire,
  runsDirFor,
  saveRun,
} from '../runtime/store.js';
import { editsFiles, isolate } from '../runtime/worktree.js';

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
  return {
    pattern: p.name,
    description: p.description,
    steps: p.nodes.filter((n) => n.kind !== 'start').map((n) => `${n.id}: ${n.label}`),
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
}

interface Managed {
  readonly run: Run;
  readonly pattern: Pattern;
  next?: string;
  /** Why a hand-off did not start (e.g. the composed score edits files over HTTP). */
  blocked?: string;
  savedTo?: string;
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
    };

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
  /** Where the file edits went (the run played in its own worktree). */
  readonly edits?: string;
}

const ACTIVE = new Set(['running', 'paused', 'awaiting-approval']);
/** How long stop_run waits for the current step to end before answering. */
const STOP_WAIT_MS = 15_000;

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

  private async launch(
    score: ExecutableScore,
    pattern: Pattern,
    req: StartRequest,
    chain: readonly ChainStep[],
  ): Promise<string> {
    const workspace = await this.opts.workspace();
    const runsDir = runsDirFor(workspace, this.opts.env);
    void autoPrune(workspace, runsDir, this.opts.env);
    const extras = await runtimeExtras(workspace, this.opts.repoRoot, this.opts.env);
    const providerName = req.provider ?? 'copilot';
    // A real AI editing files plays in its own worktree, so several can play at once.
    const isolation =
      providerName === 'copilot' && this.opts.editsAllowed && editsFiles(score)
        ? await isolate(workspace, score.pattern, this.opts.env)
        : undefined;
    const dir = isolation?.dir ?? workspace;
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
      const id = await this.launch(s, p, req, rest);
      if (managed) managed.next = id;
      return id;
    };
    const next =
      concertNext({ maestroScore: score, start: handOff }) ??
      chainNext({ chain, score, library: () => this.library(), start: handOff });
    const run = new Run({
      score,
      provider,
      tools: extras.tools,
      toolContext: isolation ? { ...extras.toolContext, workspace: dir } : extras.toolContext,
      ...(pattern.demo ? { demo: pattern.demo } : {}),
      ...(playsFromRepertoire(score.improvisation)
        ? { repertoire: await loadRepertoire(runsDir) }
        : {}),
      autoApprove: req.autoApprove === true,
      ...(providerName === 'copilot'
        ? { envHash: () => gitFingerprint(dir), scratch: await runScratch(workspace) }
        : {}),
      ...(isolation ? { isolation } : {}),
      checkpoint: true,
      onSave: async (r) => {
        const file = await saveRun(runsDir, r);
        if (managed) managed.savedTo = file;
        return file;
      },
      ...(next ? { next } : {}),
    });
    managed = { run, pattern };
    this.runs.set(run.id, managed);
    void run.start().finally(() => provider.dispose?.());
    return run.id;
  }

  private get(runId: string): Managed {
    const m = this.runs.get(runId);
    if (!m) throw new Error(`unknown run '${runId}'`);
    return m;
  }

  /** Follow hand-offs to the latest run of a chain. */
  private latest(runId: string): { managed: Managed; id: string; chain: string[] } {
    const chain = [runId];
    let id = runId;
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
      recent,
      ...(ended ? { outcome: engine.outcome } : {}),
      ...(ended && engine.reason ? { reason: engine.reason } : {}),
      ...(result ? { result } : {}),
      ...(managed.savedTo ? { savedTo: managed.savedTo } : {}),
      ...(managed.blocked ? { note: managed.blocked } : {}),
      ...(used.calls > 0 ? { tokens: formatUsage(used) } : {}),
      ...(edits ? { edits: describeEdits(edits) } : {}),
    };
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
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    while (!this.settled(runId) && Date.now() < deadline) {
      const { managed } = this.latest(runId);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        const off = managed.run.subscribe((m) => {
          if (m.type === 'next' || (m.type === 'status' && m.status !== 'running')) finish();
        });
        function finish() {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    }
    return this.view(runId);
  }

  answerApproval(
    runId: string,
    answer: { approved: boolean; updates?: Record<string, unknown> },
  ): RunView {
    const { managed, id } = this.latest(runId);
    const pause = managed.run.engine?.pause;
    // Fields left out are empty, as in the studio (e.g. the maestro's "empty feedback = go").
    const updates =
      pause?.kind === 'approval'
        ? Object.fromEntries(
            pause.outputSchema.map((f) => [f.name, answer.updates?.[f.name] ?? zeroValue(f.type)]),
          )
        : answer.updates;
    const error = managed.run.answerApproval({
      approved: answer.approved,
      ...(updates ? { updates } : {}),
      by: 'mcp',
    });
    if (error) throw new Error(error);
    return this.view(id);
  }

  answerStuck(
    runId: string,
    answer: { action: 'retry' | 'stop'; hint?: string; complexity?: Complexity },
  ): RunView {
    const { managed, id } = this.latest(runId);
    const error = managed.run.answerRecovery({ ...answer, by: 'mcp' });
    if (error) throw new Error(error);
    return this.view(id);
  }

  /**
   * Stop the latest run of the chain (any run id of it works), then wait up to
   * `waitMs` for its current step to wind down: answering "running" right after
   * a stop made callers think it had not stopped. Still ending: 'stopping'.
   */
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
