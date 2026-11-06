/**
 * Run driver: the only place where the pure engine meets I/O.
 *
 *   loop: engine pause -> [gate: before] -> provider (AI) or human
 *         -> [gate: after, AI result held for inspection] -> advance()
 *
 * Gates stop the run when paused, in step mode, or at a breakpoint, so a
 * user can look at the node input and the AI's proposed output before the
 * engine applies it. stop() aborts the live AI call and cancels the run.
 */
import { scrubbingOn, scrubText, scrubValue } from '../core/scrub.js';
import { itemOf } from '../core/items.js';
import { stepTimeLimitMs } from './limits.js';
import { KEEP_ANSWER } from './provider.js';
import type { PreloadedFile } from './preload-prompt.js';
import {
  advance,
  createEngine,
  toPerformance,
  type AdvanceResult,
  type EngineState,
} from '../core/engine.js';
import { RUN_SCHEMA_VERSION } from '../core/migrate.js';
import { MAX_AGENTS } from '../core/types.js';
import { scriptedResolution } from '../core/scripted.js';
import type {
  AgentPause,
  AiTranscript,
  EditsResult,
  PerformanceOutcome,
  ApprovalPause,
  ToolPause,
  Recovery,
  StuckPause,
  DemoScript,
  EngineEvent,
  ExecutableScore,
  Pattern,
  Performance,
  PreloadRecord,
  Resolution,
  SavedRun,
} from '../core/types.js';
import type { Provider, ProviderEvent } from './provider.js';
import type { Repertoire } from './repertoire.js';
import { checkToolPause, type ToolContext, type ToolRegistry } from './tools.js';
import { playsFromRepertoire } from '../core/jazz.js';
import { mapToolOutput } from '../core/engine.js';

export type RunStatus =
  | 'running'
  | 'paused'
  | 'awaiting-approval'
  | 'done'
  | 'failed'
  | 'cancelled';
/** Where a run halted: before a step, after its AI answered, or between the parts of a step. */
export type GatePhase = 'before' | 'after' | 'parts';
export type PartState = 'waiting' | 'running' | 'done' | 'failed' | 'kept';

export type RunMessage =
  | { readonly seq: number; readonly type: 'engine'; readonly event: EngineEvent }
  | {
      readonly seq: number;
      readonly type: 'provider';
      readonly nodeId: string;
      readonly attempt: number;
      readonly event: ProviderEvent;
      /** Jazz takes: 1..N for each take, 0 for the integrator. */
      readonly take?: number;
    }
  | {
      readonly seq: number;
      readonly type: 'status';
      readonly status: RunStatus;
      readonly nodeId?: string;
      readonly phase?: GatePhase;
      /** AI result waiting to be applied (after-gate). */
      readonly proposed?: unknown;
      readonly reason?: string;
    }
  | {
      readonly seq: number;
      readonly type: 'performance';
      readonly performance: Performance;
      readonly savedTo?: string;
    }
  | ({ readonly seq: number; readonly type: 'next' } & NextPerformance)
  | {
      readonly seq: number;
      readonly type: 'part';
      /** One sub-agent of a fanned-out step (1-based part of `total`). */
      readonly nodeId: string;
      readonly step: number;
      readonly attempt: number;
      readonly part: number;
      readonly total: number;
      /** waiting for a slot, running, done (answered), failed (no answer), kept (from an earlier attempt). */
      readonly state: PartState;
    }
  | {
      readonly seq: number;
      readonly type: 'overtime';
      readonly nodeId: string;
      /** How long the step has run when asked. */
      readonly afterMs: number;
      /** asking: a human decides; then waiting (keep going), stopping (keep what it has) or ended. */
      readonly state: 'asking' | 'waiting' | 'stopping' | 'ended';
    };

/** What a run hands on when it finishes (the maestro hands on the score it composed). */
export interface NextPerformance {
  readonly pattern: Pattern;
  readonly context: Readonly<Record<string, unknown>>;
  /** Present when the follow-up run was started. */
  readonly runId?: string;
  /** Why the follow-up could not start (e.g. a required input is missing). */
  readonly error?: string;
}

type Unsequenced<T> = T extends { seq: number } ? Omit<T, 'seq'> : never;

const DEFAULT_PARALLEL = 4;
/** Tool steps write a checkpoint at most this often (AI answers and decisions always do). */
export const CHECKPOINT_EVERY_MS = 30_000;
/** fanOut.warm: the longest the other parts wait for the first one to start answering. */
const WARM_MS = 30_000;

const NO_SANDBOX_INFO =
  'No throwaway copy of the workspace could be made: this step runs read-only and reports that it could not run.';
/** Told to a sandbox step that got no copy: it reads only, and says what it could not run. */
export const NO_SANDBOX =
  'No throwaway copy of the workspace could be made, so this step is read-only: run nothing that executes code or changes files (no tests, scripts or installs). Record what you would have run, and for each, say it could not run because no throwaway copy could be made.';

export interface RunOptions {
  readonly id?: string;
  readonly score: ExecutableScore;
  readonly provider: Provider;
  /** Used for "scripted answer" at approvals and by autoApprove. */
  readonly demo?: DemoScript;
  readonly autoApprove?: boolean;
  readonly stepMode?: boolean;
  readonly breakpoints?: readonly string[];
  /** Workspace fingerprint after each agent node (e.g. gitFingerprint). */
  readonly envHash?: () => Promise<string>;
  readonly clock?: () => string;
  /** `checkpoint`: saved mid-run (a smaller, unindented file will do; the final save follows). */
  readonly onSave?: (
    run: SavedRun,
    how?: { readonly checkpoint: boolean },
  ) => Promise<string | undefined>;
  /**
   * The run's scratch folder: executors put temporary files there, and `remove`
   * deletes it when the run ends (see store.ts runScratch).
   */
  readonly scratch?: { readonly dir: string; readonly remove: () => Promise<void> };
  /** Removed when the run ends, like scratch (e.g. the worktree of the PR it reviewed). */
  readonly cleanup?: () => Promise<void>;
  /**
   * A throwaway copy of the workspace for a sandbox step (runtime/worktree sandboxFor),
   * discarded after the call; undefined when none can be made.
   */
  readonly sandbox?: (
    label: string,
  ) => Promise<{ readonly dir: string; readonly discard: () => Promise<void> } | undefined>;
  /**
   * The run plays in its own worktree (worktree.ts); `finish` brings its edits back
   * to the workspace (or saves a patch) when the run ends.
   */
  readonly isolation?: { readonly finish: (outcome: PerformanceOutcome) => Promise<EditsResult> };
  /** fanOut: how many parts of a step play at the same time (default 4). */
  readonly parallel?: number;
  /**
   * Longest an AI step (or one part of a fanned-out step) may take before it is
   * stopped (default 15 minutes). What it already submitted is kept; with nothing
   * submitted it counts as an attempt with no result: retried, then stuck for a human.
   */
  readonly stepTimeoutMs?: number;
  /**
   * At the time limit, ask a human (answerOvertime) instead of stopping the step:
   * keep waiting another limit, or stop it keeping what it has.
   */
  readonly askOnOvertime?: boolean;
  /** Also save (through onSave) after every step, so an interrupted run can be resumed. */
  readonly checkpoint?: boolean;
  /** Continue from a restored engine (restoreEngine) instead of starting fresh. */
  readonly restore?: {
    readonly result: AdvanceResult;
    readonly basedOn: NonNullable<Performance['basedOn']>;
  };
  /** Called when the run ends (unless cancelled); may start a follow-up run (maestro's composed score, a chain step). */
  readonly next?: (performance: Performance) => Promise<NextPerformance | undefined>;
  /** Classical (improvisation 0): recorded answers to replay for identical moves. */
  readonly repertoire?: Repertoire;
  /** Tools for `tool` nodes. Without a registry, tool nodes use the pattern's demo outputs. */
  readonly tools?: ToolRegistry;
  readonly toolContext?: Omit<ToolContext, 'signal'>;
}

export interface HumanAnswer {
  readonly approved: boolean;
  readonly updates?: Readonly<Record<string, unknown>>;
  readonly by?: string;
  /** When the asker first showed the question (MCP: the first get_run that returned it). */
  readonly shownAt?: string;
  /** Use the pattern's demo answer instead. */
  readonly scripted?: boolean;
}

/** A human's decision when an AI step is stuck (out of attempts). */
export type RecoveryAnswer = Omit<Recovery, 'at'>;

let counter = 0;

/** A step that can browse and was given a URL to read: its answer depends on the web now. */
export const readsPages = (pause: AgentPause): boolean =>
  pause.capabilities.includes('web') &&
  Object.values(pause.input).some((v) =>
    (Array.isArray(v) ? v : [v]).some((x) => typeof x === 'string' && URL_LIKE.test(x.trim())),
  );

/** A URL, not a workspace path: the step fetches it itself. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

export class Run {
  readonly id: string;
  readonly score: ExecutableScore;
  readonly messages: RunMessage[] = [];
  engine: EngineState;
  status: RunStatus = 'running';
  stepMode: boolean;
  breakpoints: Set<string>;

  private readonly opts: RunOptions;
  private readonly listeners = new Set<(m: RunMessage) => void>();
  private pauseRequested = false;
  private stopRequested: string | undefined;
  private release: (() => void) | undefined;
  private approvalWaiter: ((a: HumanAnswer | undefined) => void) | undefined;
  private autoApproving: boolean;
  private recoveryWaiter: ((a: RecoveryAnswer | undefined) => void) | undefined;
  private abort: AbortController | undefined;
  private overtimeWaiter: ((a: 'wait' | 'stop') => void) | undefined;
  /** A step over its time limit, waiting for a human to say wait or stop. */
  overtime: { readonly nodeId: string; readonly afterMs: number } | undefined;
  private finished: Promise<Performance> | undefined;
  private edits: EditsResult | undefined;

  constructor(opts: RunOptions) {
    this.opts = opts;
    this.id = opts.id ?? `run-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    this.score = opts.score;
    this.stepMode = opts.stepMode ?? false;
    this.breakpoints = new Set(opts.breakpoints ?? []);
    this.autoApproving = opts.autoApprove === true;
    this.engine = undefined as unknown as EngineState;
  }

  /** Off only with SYMPHONY_SCRUB=off (e.g. to debug a repair against the raw text). */
  private readonly scrubbing = scrubbingOn();

  private now(): string {
    return this.opts.clock?.() ?? new Date().toISOString();
  }

  private push(m: Unsequenced<RunMessage>): void {
    const msg = { ...m, seq: this.messages.length } as RunMessage;
    this.messages.push(msg);
    for (const l of this.listeners) l(msg);
  }

  subscribe(listener: (m: RunMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(
    status: RunStatus,
    extra: Omit<Unsequenced<Extract<RunMessage, { type: 'status' }>>, 'type' | 'status'> = {},
  ): void {
    this.status = status;
    this.push({ type: 'status', status, ...extra });
  }

  private apply(r: AdvanceResult): void {
    if (r.rejected) throw new Error(`engine refused resolution: ${r.rejected}`);
    this.engine = r.state;
    for (const event of r.events) this.push({ type: 'engine', event });
  }

  // ── controls ──────────────────────────────────────────────────────

  pause(): void {
    if (this.pauseRequested || this.stopRequested) return;
    this.pauseRequested = true;
    this.holdParts = true;
    // A call already playing is not cut off: say when the pause takes hold.
    const at = this.engine?.pause?.nodeId;
    if (at && this.status === 'running')
      this.emitInfo(
        at,
        'Pausing: the calls already playing finish, then the run halts (no new part or step starts).',
      );
  }

  resume(): void {
    this.pauseRequested = false;
    this.holdParts = false;
    this.release?.();
  }

  /** Pass exactly one gate, then stop at the next one. */
  step(): void {
    this.pauseRequested = true;
    // One step: its parts all play, and the run halts at the next gate.
    this.holdParts = false;
    this.release?.();
  }

  setStepMode(on: boolean): void {
    this.stepMode = on;
  }

  /**
   * Answer approvals by themselves from now on (each with its unattended answer), the one
   * waiting included; or ask again. Stuck steps still ask a person unless the run started
   * unattended: a step that failed its attempts is not something to approve blindly.
   */
  setAutoApprove(on: boolean): void {
    if (this.autoApproving === on) return;
    this.autoApproving = on;
    const waiting = this.engine?.pause?.kind === 'approval' ? this.engine.pause.nodeId : undefined;
    if (waiting)
      this.emitInfo(
        waiting,
        on
          ? 'auto-approve on: this approval and the next ones answer themselves'
          : 'auto-approve off',
      );
    if (on) this.approvalWaiter?.({ approved: true, scripted: true });
  }

  /** Whether approvals answer themselves now (set at the start, changeable mid-run). */
  get autoApproves(): boolean {
    return this.autoApproving;
  }

  setBreakpoints(ids: readonly string[]): void {
    this.breakpoints = new Set(ids);
  }

  stop(reason = 'stopped by user'): void {
    this.stopRequested = reason;
    this.abort?.abort();
    this.release?.();
    this.approvalWaiter?.(undefined);
    this.recoveryWaiter?.(undefined);
  }

  answerApproval(answer: HumanAnswer): string | undefined {
    if (!this.approvalWaiter) return 'no approval is pending';
    this.approvalWaiter(answer);
    return undefined;
  }

  /** A step is over its time limit: keep waiting, or stop it and keep what it has. */
  answerOvertime(action: 'wait' | 'stop'): string | undefined {
    if (!this.overtimeWaiter) return 'no step is over its time limit';
    this.overtimeWaiter(action);
    return undefined;
  }

  /**
   * Time a step (or a part): at each limit either stop it, keeping what it has, or,
   * with askOnOvertime, ask a human and wait. Returns a function that ends the watch.
   */
  private watch(nodeId: string, stop: () => void, ask: boolean): () => void {
    const limit = this.opts.stepTimeoutMs ?? stepTimeLimitMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rounds = 0;
    let ended = false;
    const settle = (state: 'waiting' | 'stopping' | 'ended') => {
      this.overtimeWaiter = undefined;
      this.overtime = undefined;
      this.push({ type: 'overtime', nodeId, afterMs: limit * rounds, state });
    };
    const fire = () => {
      if (ended) return;
      rounds += 1;
      if (!ask) {
        this.emitInfo(
          nodeId,
          `over the ${Math.round(limit / 60_000)} min limit: stopped, keeping what it had`,
        );
        stop();
        return;
      }
      this.overtime = { nodeId, afterMs: limit * rounds };
      this.push({ type: 'overtime', nodeId, afterMs: limit * rounds, state: 'asking' });
      this.overtimeWaiter = (a) => {
        settle(a === 'stop' ? 'stopping' : 'waiting');
        if (a === 'stop') stop();
        else timer = setTimeout(fire, limit);
      };
    };
    timer = setTimeout(fire, limit);
    return () => {
      ended = true;
      clearTimeout(timer);
      if (this.overtimeWaiter) settle('ended');
    };
  }

  private emitInfo(nodeId: string, text: string): void {
    const attempt = this.engine?.pause?.kind === 'agent' ? this.engine.pause.attempt : 1;
    this.push({ type: 'provider', nodeId, attempt, event: { type: 'info', text } });
  }

  /** Answer a stuck step: retry it (with a hint or another tier) or stop the run. */
  answerRecovery(answer: RecoveryAnswer): string | undefined {
    if (!this.recoveryWaiter) return 'no stuck step is waiting';
    this.recoveryWaiter(answer);
    return undefined;
  }

  // ── loop ──────────────────────────────────────────────────────────

  private held: Promise<void> | undefined;
  /** Pressed pause (not step): parts not yet started wait. */
  private holdParts = false;

  /** Between the parts of a step: one halt for every worker, released by resume or step. */
  private holdIfPaused(nodeId: string): Promise<void> {
    if (!this.holdParts || this.stopRequested) return Promise.resolve();
    this.held ??= this.gate(nodeId, 'parts').finally(() => {
      this.held = undefined;
    });
    return this.held;
  }

  private async gate(nodeId: string, phase: GatePhase, proposed?: unknown): Promise<void> {
    if (this.stopRequested) return;
    const hit = this.pauseRequested || this.stepMode || this.breakpoints.has(nodeId);
    if (!hit) return;
    const released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    // Listeners may resume synchronously, so the waiter must exist before the pause is announced.
    this.setStatus('paused', { nodeId, phase, ...(proposed !== undefined ? { proposed } : {}) });
    await released;
    this.release = undefined;
    if (!this.stopRequested) this.setStatus('running', { nodeId });
  }

  private emitFor(pause: AgentPause, take?: number) {
    return (event: ProviderEvent) =>
      this.push({
        type: 'provider',
        nodeId: pause.nodeId,
        attempt: pause.attempt,
        event,
        ...(take !== undefined ? { take } : {}),
      });
  }

  private async play(
    pause: AgentPause,
    signal: AbortSignal,
    extra: {
      take?: number;
      integrate?: readonly unknown[];
      state?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<{ result: unknown; transcript: AiTranscript }> {
    const onEvent = this.emitFor(pause, extra.integrate ? 0 : extra.take);
    const files = await this.preload(pause, onEvent);
    // A sandbox step works in its own throwaway copy, whatever it changes there.
    const box =
      pause.sandbox && this.opts.sandbox
        ? await this.opts.sandbox(pause.nodeId).catch(() => undefined)
        : undefined;
    // Fail closed: with no copy, the step may only read, and says it could not run anything.
    const closed = pause.sandbox === true && !box;
    if (closed) onEvent({ type: 'info', text: NO_SANDBOX_INFO });
    let played: Awaited<ReturnType<Provider['runAgent']>>;
    try {
      played = await this.opts.provider.runAgent({
        pause: box
          ? pause
          : closed
            ? {
                ...pause,
                sandbox: false,
                role: 'assessor',
                directive: `${NO_SANDBOX} ${pause.directive}`,
              }
            : pause,
        state: this.engine.state,
        visit: (this.engine.visits[pause.nodeId] ?? 1) - 1,
        signal,
        onEvent,
        ...(this.opts.scratch ? { scratchDir: this.opts.scratch.dir } : {}),
        ...(files.length ? { files } : {}),
        ...(box ? { cwd: box.dir } : {}),
        ...extra,
      });
    } finally {
      await box?.discard().catch(() => undefined);
    }
    if (files.length === 0) return played;
    // The record says what the engine put in the prompt, without the text itself.
    const preloaded = files.map((f) => {
      const entry: PreloadRecord = { path: f.path, lines: f.lines };
      if (f.item && f.item !== f.path) Object.assign(entry, { item: f.item });
      if (f.range) Object.assign(entry, { range: f.range });
      if (f.omitted) Object.assign(entry, { omitted: f.omitted, ...(f.cut ? { cut: f.cut } : {}) });
      if (f.error) Object.assign(entry, { error: f.error });
      return entry;
    });
    return { ...played, transcript: { ...played.transcript, preloaded } };
  }

  /** What tools get: the run's context (memoryRoot too), its id and a signal. */
  private toolContext(signal: AbortSignal) {
    return {
      ...this.opts.toolContext,
      workspace: this.opts.toolContext?.workspace ?? '.',
      repoRoot: this.opts.toolContext?.repoRoot ?? '.',
      signal,
      runId: this.id,
    };
  }

  /** pause.preload: read the listed workspace files whole (the files.read tool), for the prompt. */
  private async preload(
    pause: AgentPause,
    onEvent: (e: ProviderEvent) => void,
  ): Promise<PreloadedFile[]> {
    const list = pause.preload ? pause.input[pause.preload] : undefined;
    const read = this.opts.tools?.get('files.read');
    if (!Array.isArray(list) || list.length === 0 || !read) return [];
    const out = await read
      .run({ paths: list }, this.toolContext(new AbortController().signal))
      .catch((e: unknown) => {
        // The step still runs; it is told, file by file, to read them with tools.
        const error = `read failed: ${e instanceof Error ? e.message : String(e)}`;
        const paths = list.filter((p): p is string => typeof p === 'string' && !URL_LIKE.test(p));
        return {
          files: paths.map((p) => ({
            path: itemOf(p).path,
            item: p.trim(),
            text: `(${error})`,
            lines: 0,
            error,
          })),
        };
      });
    const files = (Array.isArray(out.files) ? out.files : []) as PreloadedFile[];
    const shown = files.filter((f) => !f.error);
    const lines = shown.reduce((n, f) => n + f.lines, 0);
    const failed = files.filter((f) => f.error);
    if (files.length > 0)
      onEvent({
        type: 'info',
        text: `the engine read ${shown.length} file(s) in full (${lines} lines) into the prompt${failed.length ? `; ${failed.length} could not be read (${failed.map((f) => `${f.path}: ${f.error}`).join(', ')}): the step reads them with tools` : ''}`,
      });
    return files;
  }

  /** Classical: the same move of the same song replays the recorded notes. */
  private async fromRepertoire(
    pause: AgentPause,
  ): Promise<{ result: unknown; transcript: AiTranscript } | undefined> {
    if (!playsFromRepertoire(pause.improvisation) || pause.role !== 'assessor') return undefined;
    if (!this.opts.repertoire) return undefined;
    // The replay key holds the workspace's state, not a web page's: a step that reads pages
    // is played again, since what the page says today may differ.
    if (readsPages(pause) || pause.fresh) return undefined;
    // Only answers recorded with the model settings this step asks for now.
    const settings = (await this.opts.provider.requested?.(pause)) ?? '';
    const take = this.opts.repertoire.find(
      this.score.id,
      pause.moveKey,
      this.opts.provider.name,
      settings,
    );
    if (!take) return undefined;
    // The first steps' replay key has no fingerprint yet (none is taken before an AI step): the
    // workspace must still be what it was when the answer was recorded (e.g. HEAD not moved).
    if (take.envHash !== undefined && this.opts.envHash) {
      if ((await this.opts.envHash()) !== take.envHash) return undefined;
    }
    const emit = this.emitFor(pause);
    emit({
      type: 'info',
      text: `🎼 replayed from repertoire (${take.file}): same song, same notes`,
    });
    if (take.transcript?.output) emit({ type: 'delta', text: take.transcript.output });
    return {
      result: take.result,
      transcript: {
        ...(take.transcript ?? {
          provider: this.opts.provider.name,
          prompt: '',
          output: '',
          toolCalls: [],
        }),
        fromRepertoire: take.file,
      },
    };
  }

  /**
   * fanOut: one call per part, at most `parallel` at a time. Answers stay in part
   * order whatever finishes first; a part that errors gives no answer (the engine
   * says which part). Parts show in the AI output as takes 1..n.
   */
  private async playParts(
    pause: AgentPause,
    signal: AbortSignal,
  ): Promise<{ result: unknown; transcript: AiTranscript }> {
    const { parts, partsDone, ...single } = pause;
    const all = parts ?? [];
    const out: { result: unknown; transcript: AiTranscript }[] = [];
    const note = (output: string): AiTranscript => ({
      provider: this.opts.provider.name,
      prompt: pause.directive,
      output,
      toolCalls: [],
    });
    // Parts that passed at an earlier attempt are not played again.
    const todo = all.map((_, i) => i).filter((i) => !partsDone?.[i]);
    const tell = (i: number, state: PartState) =>
      this.push({
        type: 'part',
        nodeId: pause.nodeId,
        step: pause.step,
        attempt: pause.attempt,
        part: i + 1,
        total: all.length,
        state,
      });
    all.forEach((_, i) => tell(i, partsDone?.[i] ? 'kept' : 'waiting'));
    for (const [i, kept] of (partsDone ?? []).entries())
      if (kept) out[i] = { result: kept, transcript: note('(kept from an earlier attempt)') };
    if (todo.length < all.length)
      this.emitInfo(
        pause.nodeId,
        `${all.length - todo.length} of ${all.length} parts kept from the last attempt; playing the other ${todo.length}`,
      );
    // Each part has its own clock; with a human watching, the whole step has one (runAgent).
    const ownClock = !this.opts.askOnOvertime;
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !signal.aborted) {
        // A pause holds the parts not yet started; those playing finish.
        await this.holdIfPaused(pause.nodeId);
        if (next >= todo.length || signal.aborted) break;
        const i = todo[next++]!;
        const part = all[i]!;
        const ctrl = new AbortController();
        const follow = () => ctrl.abort(signal.reason);
        signal.addEventListener('abort', follow, { once: true });
        const unwatch = ownClock
          ? this.watch(pause.nodeId, () => ctrl.abort(KEEP_ANSWER), false)
          : () => undefined;
        tell(i, 'running');
        out[i] = await this.play({ ...single, input: part }, ctrl.signal, {
          take: i + 1,
          state: { ...this.engine.state, ...part },
        })
          .catch((e: Error) => {
            if (e.name === 'AbortError' && ctrl.signal.reason !== KEEP_ANSWER) throw e;
            return {
              result: undefined,
              transcript: note(
                e.name === 'AbortError'
                  ? 'stopped at the time limit before it submitted'
                  : `provider error: ${e.message}`,
              ),
            };
          })
          .finally(() => {
            unwatch();
            signal.removeEventListener('abort', follow);
          });
        tell(i, out[i]?.result === undefined ? 'failed' : 'done');
      }
    };
    const width = Math.min(
      pause.parallel ?? this.opts.parallel ?? DEFAULT_PARALLEL,
      MAX_AGENTS,
      Math.max(1, todo.length),
    );
    // Warm: one part first; the rest start once the model is answering it (its prompt cached).
    const warm = pause.warmFirst && width > 1 && todo.length > 1;
    const first = warm ? worker() : undefined;
    if (warm) await this.warmUp(pause.nodeId, todo[0]! + 1, signal);
    await Promise.all([
      ...(first ? [first] : []),
      ...Array.from({ length: warm ? width - 1 : width }, worker),
    ]);
    // Stopped at the time limit: finished parts count; the rest are retried.
    if (signal.aborted && signal.reason !== KEEP_ANSWER)
      throw new DOMException('aborted', 'AbortError');
    for (const i of todo) out[i] ??= { result: undefined, transcript: note('not played: stopped') };
    const transcripts = out.map((o) => o.transcript);
    const model = transcripts.find((t) => t.model)?.model;
    // The step's own clock: first part's start to last part's end (parts kept from an earlier
    // attempt are not timed again).
    const starts = transcripts.flatMap((t) => (t.startedAt ? [t.startedAt] : [])).toSorted();
    const ends = transcripts.flatMap((t) => (t.completedAt ? [t.completedAt] : [])).toSorted();
    return {
      result: { parts: out.map((o) => o.result) },
      transcript: {
        provider: this.opts.provider.name,
        ...(model ? { model } : {}),
        ...(starts.length ? { startedAt: starts[0]! } : {}),
        ...(ends.length ? { completedAt: ends.at(-1)! } : {}),
        prompt: transcripts[0]?.prompt ?? pause.directive,
        output: transcripts
          .map((t, i) => `## Part ${i + 1} of ${all.length}\n${t.output}`)
          .join('\n\n'),
        toolCalls: transcripts.flatMap((t) => t.toolCalls),
        parts: transcripts,
      },
    };
  }

  /**
   * Resolves once part `take` of this step shows model output (not the engine's own notes),
   * ends, or WARM_MS passes: never later, so a slow first part delays the rest by at most that.
   */
  private warmUp(nodeId: string, take: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, WARM_MS);
      signal.addEventListener('abort', done, { once: true });
      const off = this.subscribe((m) => {
        const answering =
          m.type === 'provider' &&
          m.nodeId === nodeId &&
          m.take === take &&
          m.event.type !== 'info';
        const ended =
          m.type === 'part' &&
          m.nodeId === nodeId &&
          m.part === take &&
          (m.state === 'done' || m.state === 'failed');
        if (answering || ended) done();
      });
    });
  }

  /** Jazz: independent takes in parallel, then a bandleader merges them. */
  private async playTakes(
    pause: AgentPause,
    signal: AbortSignal,
  ): Promise<{ result: unknown; transcript: AiTranscript }> {
    const settled = await Promise.allSettled(
      Array.from({ length: pause.takes }, (_, i) => this.play(pause, signal, { take: i + 1 })),
    );
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const takes = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    if (takes.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
    if (takes.length === 1) return takes[0]!;
    const merged = await this.play(pause, signal, { integrate: takes.map((t) => t.result) });
    return {
      result: merged.result,
      transcript: { ...merged.transcript, takes: takes.map((t) => t.transcript) },
    };
  }

  private async runAgent(pause: AgentPause): Promise<Resolution | undefined> {
    await this.gate(pause.nodeId, 'before');
    if (this.stopRequested) return undefined;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const limit = this.opts.stepTimeoutMs ?? stepTimeLimitMs();
    let timedOut = false;
    // Parts keep their own clocks unless a human watches the whole step.
    const unwatch =
      pause.parts && !this.opts.askOnOvertime
        ? () => undefined
        : this.watch(
            pause.nodeId,
            () => {
              timedOut = true;
              this.abort?.abort(KEEP_ANSWER);
            },
            this.opts.askOnOvertime === true,
          );
    let result: unknown;
    let transcript: AiTranscript;
    try {
      const res =
        (await this.fromRepertoire(pause)) ??
        (pause.parts
          ? await this.playParts(pause, signal)
          : pause.takes > 1
            ? await this.playTakes(pause, signal)
            : await this.play(pause, signal));
      result = res.result;
      transcript = res.transcript;
    } catch (e) {
      if (this.stopRequested || ((e as Error).name === 'AbortError' && !timedOut)) return undefined;
      // The provider cannot work as configured (e.g. not signed in): stop now and say why.
      if ((e as Error).name === 'SetupError') {
        // Its text can quote the provider's reply: it becomes the run's reason, so scrub it.
        const why = this.scrubbing ? scrubText((e as Error).message) : (e as Error).message;
        this.emitFor(pause)({ type: 'info', text: why });
        this.stopRequested = why;
        return undefined;
      }
      result = undefined;
      transcript = {
        provider: this.opts.provider.name,
        prompt: pause.directive,
        output: timedOut
          ? `timed out: the step took longer than ${Math.round(limit / 1000)}s and was stopped before it submitted`
          : `provider error: ${(e as Error).message}`,
        toolCalls: [],
      };
      this.emitFor(pause)({ type: 'info', text: transcript.output });
    } finally {
      unwatch();
      this.abort = undefined;
    }
    await this.gate(pause.nodeId, 'after', result);
    if (this.stopRequested) return undefined;
    const envHash = this.opts.envHash ? await this.opts.envHash() : undefined;
    return {
      kind: 'agent',
      pauseId: pause.pauseId,
      result,
      transcript,
      ...(envHash !== undefined ? { envHash } : {}),
      at: this.now(),
    };
  }

  private async runTool(pause: ToolPause): Promise<Resolution | undefined> {
    await this.gate(pause.nodeId, 'before');
    if (this.stopRequested) return undefined;
    const tools = this.opts.tools;
    // The offline demo is a function of (pattern, goal, context) only: it plays the
    // demo's tool outputs rather than reading this machine's files, runs or servers.
    const scripted =
      this.opts.provider.name === 'scripted' && this.opts.demo?.tools?.[pause.nodeId];
    if (!tools || scripted) {
      return scriptedResolution(this.opts.demo, pause, this.engine, this.now());
    }
    const emit = (text: string) =>
      this.push({
        type: 'provider',
        nodeId: pause.nodeId,
        attempt: 1,
        event: { type: 'info', text },
      });
    const invalid = checkToolPause(pause, tools);
    if (invalid) return { kind: 'tool', pauseId: pause.pauseId, error: invalid, at: this.now() };
    this.abort = new AbortController();
    emit(`running tool ${pause.tool}`);
    let res: Resolution;
    try {
      const raw = await tools.get(pause.tool)!.run(pause.args, this.toolContext(this.abort.signal));
      const updates = mapToolOutput(pause.output, raw);
      emit(
        Object.entries(updates)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} item(s)` : JSON.stringify(v)}`)
          .join(', '),
      );
      res = { kind: 'tool', pauseId: pause.pauseId, updates, at: this.now() };
    } catch (e) {
      if (this.stopRequested) return undefined;
      res = { kind: 'tool', pauseId: pause.pauseId, error: (e as Error).message, at: this.now() };
    } finally {
      this.abort = undefined;
    }
    await this.gate(
      pause.nodeId,
      'after',
      res.kind === 'tool' ? (res.updates ?? { error: res.error }) : undefined,
    );
    return this.stopRequested ? undefined : res;
  }

  private async runApproval(pause: ApprovalPause): Promise<Resolution | undefined> {
    await this.gate(pause.nodeId, 'before');
    if (this.stopRequested) return undefined;
    if (this.autoApproving)
      return scriptedResolution(this.opts.demo, pause, this.engine, this.now());
    const answered = new Promise<HumanAnswer | undefined>((resolve) => {
      this.approvalWaiter = resolve;
    });
    const askedAt = this.now();
    this.setStatus('awaiting-approval', { nodeId: pause.nodeId });
    const answer = await answered;
    this.approvalWaiter = undefined;
    if (!answer || this.stopRequested) return undefined;
    this.setStatus('running', { nodeId: pause.nodeId });
    if (answer.scripted) return scriptedResolution(this.opts.demo, pause, this.engine, this.now());
    return {
      kind: 'approval',
      pauseId: pause.pauseId,
      approved: answer.approved,
      ...(answer.updates ? { updates: answer.updates } : {}),
      by: answer.by ?? 'user',
      askedAt,
      ...(answer.shownAt ? { shownAt: answer.shownAt } : {}),
      at: this.now(),
    };
  }

  private async runRecovery(pause: StuckPause): Promise<Resolution | undefined> {
    // Unattended runs have nobody to ask: the step fails as it always did.
    if (this.opts.autoApprove) {
      return scriptedResolution(this.opts.demo, pause, this.engine, this.now());
    }
    const answered = new Promise<RecoveryAnswer | undefined>((resolve) => {
      this.recoveryWaiter = resolve;
    });
    this.setStatus('awaiting-approval', { nodeId: pause.nodeId });
    const answer = await answered;
    this.recoveryWaiter = undefined;
    if (!answer || this.stopRequested) return undefined;
    this.setStatus('running', { nodeId: pause.nodeId });
    return {
      kind: 'recovery',
      pauseId: pause.pauseId,
      action: answer.action,
      ...(answer.hint?.trim() ? { hint: answer.hint.trim() } : {}),
      ...(answer.complexity ? { complexity: answer.complexity } : {}),
      by: answer.by ?? 'user',
      at: this.now(),
    };
  }

  private performance(): Performance {
    const p: Performance = {
      ...toPerformance(this.engine),
      provider: this.opts.provider.name,
      ...(this.edits ? { edits: this.edits } : {}),
    };
    return this.opts.restore ? { ...p, basedOn: this.opts.restore.basedOn } : p;
  }

  /** Write the run as it stands; a failed write never stops the run. */
  private save(checkpoint = false): Promise<string | undefined> {
    const run: SavedRun = {
      schemaVersion: RUN_SCHEMA_VERSION,
      score: this.score,
      performance: this.performance(),
    };
    this.lastCheckpoint = Date.now();
    return this.opts.onSave!(run, { checkpoint }).catch(() => undefined);
  }

  private lastCheckpoint = 0;

  start(): Promise<Performance> {
    this.finished ??= this.loop();
    return this.finished;
  }

  private async loop(): Promise<Performance> {
    this.setStatus('running');
    this.apply(this.opts.restore?.result ?? createEngine(this.score, { startedAt: this.now() }));
    while (this.engine.kind === 'running' && this.engine.pause) {
      const pause = this.engine.pause;
      const res =
        pause.kind === 'agent'
          ? await this.runAgent(pause)
          : pause.kind === 'tool'
            ? await this.runTool(pause)
            : pause.kind === 'stuck'
              ? await this.runRecovery(pause)
              : await this.runApproval(pause);
      if (!res) {
        const current = this.engine.pause ?? pause;
        const cancel = {
          kind: 'cancel' as const,
          pauseId: current.pauseId,
          reason: `${this.stopRequested ?? 'stopped'} at '${current.nodeId}'`,
          at: this.now(),
        };
        // A stop's reason is recorded like any answer: scrubbed first.
        this.apply(advance(this.score, this.engine, this.scrubbing ? scrubValue(cancel) : cancel));
        break;
      }
      // What the engine records is what gets saved: secrets go before it sees them (core/scrub).
      this.apply(advance(this.score, this.engine, this.scrubbing ? scrubValue(res) : res));
      // Every AI answer and decision is saved at once; a tool result at most every
      // CHECKPOINT_EVERY_MS (the whole run is rewritten each time), since it runs again on
      // resume. Except before an executor: once it edits, the tool would see another workspace
      // (a test lock taken again on bent tests).
      const next = this.engine.pause;
      const edits = next?.kind === 'agent' && next.role === 'executor';
      if (
        this.opts.checkpoint &&
        this.engine.kind === 'running' &&
        (res.kind !== 'tool' || edits || Date.now() - this.lastCheckpoint >= CHECKPOINT_EVERY_MS)
      )
        await this.save(true);
    }
    if (this.opts.isolation) {
      const outcome = this.performance().outcome;
      this.edits = await this.opts.isolation.finish(outcome).catch((e: Error) => ({
        kind: 'unchanged' as const,
        files: [],
        reason: `could not collect the edits: ${e.message}`,
      }));
    }
    const performance = this.performance();
    let savedTo: string | undefined;
    if (this.opts.onSave) savedTo = await this.save();
    this.push({ type: 'performance', performance, ...(savedTo ? { savedTo } : {}) });
    // The hook decides what follows which outcome (a chain stops on failure, backlog items go on).
    if (this.opts.next && performance.outcome !== 'cancelled') {
      const next = await this.opts.next(performance).catch(() => undefined);
      if (next) this.push({ type: 'next', ...next });
    }
    // Clean up what the run no longer needs; a failed removal never fails the run.
    await this.opts.scratch?.remove().catch(() => undefined);
    await this.opts.cleanup?.().catch(() => undefined);
    const status: RunStatus =
      this.engine.kind === 'failed'
        ? 'failed'
        : performance.outcome === 'cancelled'
          ? 'cancelled'
          : 'done';
    this.setStatus(status, performance.reason ? { reason: performance.reason } : {});
    return performance;
  }
}

/** Run a score to completion: `new Run({ score, provider, ...opts }).start()`. */
export function performScore(
  score: ExecutableScore,
  provider: Provider,
  opts: Omit<RunOptions, 'score' | 'provider'> = {},
): Promise<Performance> {
  return new Run({ ...opts, score, provider }).start();
}
