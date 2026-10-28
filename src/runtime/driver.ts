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
import {
  advance,
  createEngine,
  toPerformance,
  type AdvanceResult,
  type EngineState,
} from '../core/engine.js';
import { RUN_SCHEMA_VERSION } from '../core/migrate.js';
import { scriptedResolution } from '../core/scripted.js';
import type {
  AgentPause,
  AiTranscript,
  ApprovalPause,
  ToolPause,
  Recovery,
  StuckPause,
  DemoScript,
  EngineEvent,
  ExecutableScore,
  Pattern,
  Performance,
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
export type GatePhase = 'before' | 'after';

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
  | ({ readonly seq: number; readonly type: 'next' } & NextPerformance);

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
  readonly onSave?: (run: SavedRun) => Promise<string | undefined>;
  /** Also save (through onSave) after every step, so an interrupted run can be resumed. */
  readonly checkpoint?: boolean;
  /** Continue from a restored engine (restoreEngine) instead of starting fresh. */
  readonly restore?: {
    readonly result: AdvanceResult;
    readonly basedOn: NonNullable<Performance['basedOn']>;
  };
  /** Called after a successful run; may start a follow-up run (the maestro's composed score). */
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
  /** Use the pattern's demo answer instead. */
  readonly scripted?: boolean;
}

/** A human's decision when an AI step is stuck (out of attempts). */
export type RecoveryAnswer = Omit<Recovery, 'at'>;

let counter = 0;

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
  private recoveryWaiter: ((a: RecoveryAnswer | undefined) => void) | undefined;
  private abort: AbortController | undefined;
  private finished: Promise<Performance> | undefined;

  constructor(opts: RunOptions) {
    this.opts = opts;
    this.id = opts.id ?? `run-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    this.score = opts.score;
    this.stepMode = opts.stepMode ?? false;
    this.breakpoints = new Set(opts.breakpoints ?? []);
    this.engine = undefined as unknown as EngineState;
  }

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
    this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    this.release?.();
  }

  /** Pass exactly one gate, then stop at the next one. */
  step(): void {
    this.pauseRequested = true;
    this.release?.();
  }

  setStepMode(on: boolean): void {
    this.stepMode = on;
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

  /** Answer a stuck step: retry it (with a hint or another tier) or stop the run. */
  answerRecovery(answer: RecoveryAnswer): string | undefined {
    if (!this.recoveryWaiter) return 'no stuck step is waiting';
    this.recoveryWaiter(answer);
    return undefined;
  }

  // ── loop ──────────────────────────────────────────────────────────

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
    extra: { take?: number; integrate?: readonly unknown[] } = {},
  ): Promise<{ result: unknown; transcript: AiTranscript }> {
    return this.opts.provider.runAgent({
      pause,
      state: this.engine.state,
      visit: (this.engine.visits[pause.nodeId] ?? 1) - 1,
      signal,
      onEvent: this.emitFor(pause, extra.integrate ? 0 : extra.take),
      ...extra,
    });
  }

  /** Classical: the same move of the same song replays the recorded notes. */
  private fromRepertoire(
    pause: AgentPause,
  ): { result: unknown; transcript: AiTranscript } | undefined {
    if (!playsFromRepertoire(pause.improvisation) || pause.role !== 'assessor') return undefined;
    const take = this.opts.repertoire?.find(this.score.id, pause.moveKey, this.opts.provider.name);
    if (!take) return undefined;
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
    let result: unknown;
    let transcript: AiTranscript;
    try {
      const res =
        this.fromRepertoire(pause) ??
        (pause.takes > 1 ? await this.playTakes(pause, signal) : await this.play(pause, signal));
      result = res.result;
      transcript = res.transcript;
    } catch (e) {
      if (this.stopRequested || (e as Error).name === 'AbortError') return undefined;
      result = undefined;
      transcript = {
        provider: this.opts.provider.name,
        prompt: pause.directive,
        output: `provider error: ${(e as Error).message}`,
        toolCalls: [],
      };
      this.emitFor(pause)({ type: 'info', text: transcript.output });
    } finally {
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
      const raw = await tools.get(pause.tool)!.run(pause.args, {
        workspace: this.opts.toolContext?.workspace ?? '.',
        repoRoot: this.opts.toolContext?.repoRoot ?? '.',
        signal: this.abort.signal,
      });
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
    if (this.opts.autoApprove)
      return scriptedResolution(this.opts.demo, pause, this.engine, this.now());
    const answered = new Promise<HumanAnswer | undefined>((resolve) => {
      this.approvalWaiter = resolve;
    });
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
    const p = { ...toPerformance(this.engine), provider: this.opts.provider.name };
    return this.opts.restore ? { ...p, basedOn: this.opts.restore.basedOn } : p;
  }

  /** Write the run as it stands; a failed write never stops the run. */
  private save(): Promise<string | undefined> {
    const run: SavedRun = {
      schemaVersion: RUN_SCHEMA_VERSION,
      score: this.score,
      performance: this.performance(),
    };
    return this.opts.onSave!(run).catch(() => undefined);
  }

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
        this.apply(
          advance(this.score, this.engine, {
            kind: 'cancel',
            pauseId: current.pauseId,
            reason: `${this.stopRequested ?? 'stopped'} at '${current.nodeId}'`,
            at: this.now(),
          }),
        );
        break;
      }
      this.apply(advance(this.score, this.engine, res));
      if (this.opts.checkpoint && this.engine.kind === 'running') await this.save();
    }
    const performance = this.performance();
    let savedTo: string | undefined;
    if (this.opts.onSave) savedTo = await this.save();
    this.push({ type: 'performance', performance, ...(savedTo ? { savedTo } : {}) });
    if (this.opts.next && performance.outcome === 'success') {
      const next = await this.opts.next(performance).catch(() => undefined);
      if (next) this.push({ type: 'next', ...next });
    }
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
