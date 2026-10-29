/**
 * Replay and visualization helpers over the engine's event log. Pure.
 *
 *   reduceFrame(frame, event) — incremental view model (live runs)
 *   framesOf(events)          — full timeline (scrubbing saved runs)
 *   replayPerformance(score, perf) — re-run the engine on recorded answers
 *   divergence(a, b)          — compare two performances
 */
import { ENGINE_VERSION, RUN_SCHEMA_VERSION } from './migrate.js';
import { advance, createEngine, type AdvanceResult } from './engine.js';
import type {
  EngineEvent,
  ExecutableScore,
  Pause,
  Performance,
  PerformanceOutcome,
  PerformedStep,
  Resolution,
  StateChange,
} from './types.js';

export type NodeStatus = 'active' | 'paused' | 'done' | 'failed';

export interface Frame {
  readonly index: number;
  readonly event?: EngineEvent;
  readonly step: number;
  readonly activeNodeId?: string;
  readonly pausedNodeId?: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly nodeStatus: Readonly<Record<string, NodeStatus>>;
  readonly nodeVisits: Readonly<Record<string, number>>;
  readonly edgeCounts: Readonly<Record<string, number>>;
  readonly lastEdge?: {
    readonly id: string;
    readonly carried: readonly string[];
    readonly values: Readonly<Record<string, unknown>>;
  };
  readonly lastChanges: readonly StateChange[];
  readonly rejected?: { readonly nodeId: string; readonly errors: readonly string[] };
  readonly outcome?: PerformanceOutcome;
  readonly error?: string;
}

export const EMPTY_FRAME: Frame = {
  index: -1,
  step: 0,
  state: {},
  nodeStatus: {},
  nodeVisits: {},
  edgeCounts: {},
  lastChanges: [],
};

export function reduceFrame(f: Frame, e: EngineEvent): Frame {
  const base = { ...f, index: f.index + 1, event: e };
  switch (e.type) {
    case 'run-started':
      return { ...EMPTY_FRAME, index: base.index, event: e, state: e.state };
    case 'node-entered': {
      const nodeStatus = { ...f.nodeStatus };
      if (f.activeNodeId && nodeStatus[f.activeNodeId] === 'active')
        nodeStatus[f.activeNodeId] = 'done';
      nodeStatus[e.nodeId] = 'active';
      return {
        ...base,
        step: e.step,
        activeNodeId: e.nodeId,
        nodeStatus,
        nodeVisits: { ...f.nodeVisits, [e.nodeId]: (f.nodeVisits[e.nodeId] ?? 0) + 1 },
        lastChanges: [],
      };
    }
    case 'guard-evaluated':
      return base;
    case 'edge-taken':
      return {
        ...base,
        nodeStatus: { ...f.nodeStatus, [e.from]: 'done' },
        edgeCounts: { ...f.edgeCounts, [e.edgeId]: (f.edgeCounts[e.edgeId] ?? 0) + 1 },
        lastEdge: { id: e.edgeId, carried: e.carried, values: e.values },
      };
    case 'paused':
      return {
        ...base,
        pausedNodeId: e.pause.nodeId,
        nodeStatus: { ...f.nodeStatus, [e.pause.nodeId]: 'paused' },
      };
    case 'response-rejected':
      return { ...base, rejected: { nodeId: e.nodeId, errors: e.errors } };
    case 'recovered':
      return base;
    case 'node-completed': {
      const state = { ...f.state };
      for (const c of e.changes) state[c.key] = c.after;
      const { pausedNodeId: _p, rejected: _r, ...rest } = base;
      return {
        ...rest,
        state,
        lastChanges: e.changes,
        nodeStatus: { ...f.nodeStatus, [e.nodeId]: 'done' },
      };
    }
    case 'run-completed': {
      const nodeStatus = { ...f.nodeStatus };
      if (f.activeNodeId) nodeStatus[f.activeNodeId] = 'done';
      const { pausedNodeId: _p, ...rest } = base;
      return { ...rest, nodeStatus, outcome: e.outcome };
    }
    case 'run-failed': {
      const target = e.nodeId ?? f.activeNodeId;
      const { pausedNodeId: _p, ...rest } = base;
      return {
        ...rest,
        outcome: 'failed',
        error: e.error,
        nodeStatus: target ? { ...f.nodeStatus, [target]: 'failed' } : f.nodeStatus,
      };
    }
  }
}

export function framesOf(events: readonly EngineEvent[]): Frame[] {
  const frames: Frame[] = [];
  let f = EMPTY_FRAME;
  for (const e of events) {
    f = reduceFrame(f, e);
    frames.push(f);
  }
  return frames;
}

// ── Divergence ─────────────────────────────────────────────────────

export interface Divergence {
  /** Different node path. Hard divergence. */
  readonly structural: boolean;
  readonly firstDivergentStep?: number;
  /** Verdict outcomes differ at these steps. Hard divergence. */
  readonly semantic: readonly { readonly step: number; readonly a?: string; readonly b?: string }[];
  /** State hashes differ at these steps (data or workspace changed). */
  readonly environmental: readonly number[];
  readonly outcome: { readonly a: PerformanceOutcome; readonly b: PerformanceOutcome };
  readonly reproduced: boolean;
}

export function divergence(a: Performance, b: Performance): Divergence {
  const n = Math.max(a.steps.length, b.steps.length);
  let first: number | undefined;
  const semantic: { step: number; a?: string; b?: string }[] = [];
  const environmental: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const x = a.steps[i];
    const y = b.steps[i];
    if (!x || !y || x.nodeId !== y.nodeId) {
      first ??= i + 1;
      continue;
    }
    if (x.verdict?.outcome !== y.verdict?.outcome) {
      semantic.push({
        step: x.step,
        ...(x.verdict ? { a: x.verdict.outcome } : {}),
        ...(y.verdict ? { b: y.verdict.outcome } : {}),
      });
    }
    if (x.stateHashAfter !== y.stateHashAfter) environmental.push(x.step);
  }
  const structural = first !== undefined;
  return {
    structural,
    ...(first !== undefined ? { firstDivergentStep: first } : {}),
    semantic,
    environmental,
    outcome: { a: a.outcome, b: b.outcome },
    reproduced:
      !structural && semantic.length === 0 && environmental.length === 0 && a.outcome === b.outcome,
  };
}

// ── Replay ─────────────────────────────────────────────────────────

/** The n-th answer (0-based) recorded for a step: rejected attempts first, then the accepted one. */
function resolutionFrom(step: PerformedStep, pauseId: string, n: number): Resolution | undefined {
  const attempts = step.attempts ?? [];
  if (n < attempts.length) {
    const a = attempts[n]!;
    if (step.kind === 'tool') {
      return a.result !== undefined
        ? {
            kind: 'tool',
            pauseId,
            updates: a.result as Record<string, unknown>,
            ...(a.at ? { at: a.at } : {}),
          }
        : { kind: 'tool', pauseId, error: a.errors.join('; '), ...(a.at ? { at: a.at } : {}) };
    }
    if (step.kind === 'agent') {
      return {
        kind: 'agent',
        pauseId,
        result: a.result,
        ...(a.transcript ? { transcript: a.transcript } : {}),
        ...(a.at ? { at: a.at } : {}),
      };
    }
    return {
      kind: 'approval',
      pauseId,
      approved: true,
      ...(a.result !== undefined ? { updates: a.result as Record<string, unknown> } : {}),
      ...(a.at ? { at: a.at } : {}),
    };
  }
  if (step.kind === 'tool') {
    return {
      kind: 'tool',
      pauseId,
      updates: step.updates ?? {},
      ...(step.at ? { at: step.at } : {}),
    };
  }
  if (step.kind === 'agent' && step.verdict) {
    return {
      kind: 'agent',
      pauseId,
      result: {
        updates: step.updates ?? {},
        verdict: step.verdict,
        ...(step.next ? { next: step.next } : {}),
      },
      ...(step.envHash !== undefined ? { envHash: step.envHash } : {}),
      ...(step.transcript ? { transcript: step.transcript } : {}),
      ...(step.at ? { at: step.at } : {}),
    };
  }
  if (step.kind === 'approval' && step.approval) {
    return {
      kind: 'approval',
      pauseId,
      approved: step.approval.approved,
      ...(step.updates ? { updates: step.updates } : {}),
      ...(step.approval.by ? { by: step.approval.by } : {}),
      ...(step.at ? { at: step.at } : {}),
    };
  }
  return undefined;
}

/** Re-run the engine feeding the recorded answers; proves a Performance is reproducible. */
/**
 * Feeds a performance's recorded answers back pause by pause: each attempt in
 * order, then the accepted answer; at a stuck step, the human's recorded
 * decision. Runs recorded before stuck steps existed failed there, so a
 * recorded step without a decision means 'stop'. Undefined when nothing was
 * recorded (an interrupted or cancelled run).
 */
function recordedAnswers(perf: Performance): (pause: Pause) => Resolution | undefined {
  const fed = new Map<number, number>();
  const decided = new Map<number, number>();
  return (pause) => {
    const recorded = perf.steps.find((s) => s.step === pause.step && s.nodeId === pause.nodeId);
    if (!recorded) return undefined;
    if (pause.kind === 'stuck') {
      const k = decided.get(pause.step) ?? 0;
      decided.set(pause.step, k + 1);
      const decision = recorded.recoveries?.[k] ?? { action: 'stop' as const };
      return { kind: 'recovery', pauseId: pause.pauseId, ...decision };
    }
    const n = fed.get(pause.step) ?? 0;
    fed.set(pause.step, n + 1);
    return resolutionFrom(recorded, pause.pauseId, n);
  };
}

export function replayPerformance(
  score: ExecutableScore,
  perf: Performance,
): { readonly result: AdvanceResult; readonly divergence: Divergence } {
  let r = createEngine(score, { startedAt: perf.startedAt });
  const next = recordedAnswers(perf);
  while (r.state.kind === 'running' && r.state.pause) {
    const pause = r.state.pause;
    const res = next(pause);
    // A checkpoint of an unfinished run replays up to where it stopped.
    if (!res && perf.outcome === 'in-progress') break;
    if (!res) {
      r = advance(score, r.state, {
        kind: 'cancel',
        pauseId: pause.pauseId,
        reason: perf.reason ?? 'no recorded answer',
        ...(perf.completedAt ? { at: perf.completedAt } : {}),
      });
      break;
    }
    r = advance(score, r.state, res);
  }
  const replayed: Performance = {
    schemaVersion: RUN_SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    scoreId: r.state.scoreId,
    startedAt: r.state.startedAt,
    outcome: r.state.kind === 'running' ? 'in-progress' : r.state.outcome,
    finalState: r.state.state,
    steps: r.state.steps,
    events: r.state.events,
  };
  return { result: r, divergence: divergence(perf, replayed) };
}

/** Raised when recorded answers no longer fit the score (the run cannot be restored). */
export class RestoreError extends Error {}

/**
 * Rebuild the engine from a (possibly unfinished) performance: feed its recorded
 * answers back through the pure engine and stop at the first step that has none,
 * or once `throughStep` is done, leaving the engine waiting there. This is what
 * makes every saved run a checkpoint: resume continues live from that pause,
 * fork does the same from an earlier step. `events` holds the whole history.
 */
export function restoreEngine(
  score: ExecutableScore,
  perf: Performance,
  opts: { readonly throughStep?: number; readonly startedAt?: string } = {},
): AdvanceResult {
  let r = createEngine(score, { startedAt: opts.startedAt ?? perf.startedAt });
  const events = [...r.events];
  const next = recordedAnswers(perf);
  while (r.state.kind === 'running' && r.state.pause) {
    const pause = r.state.pause;
    if (opts.throughStep !== undefined && pause.step > opts.throughStep) break;
    const res = next(pause);
    if (!res) break;
    r = advance(score, r.state, res);
    if (r.rejected) {
      throw new RestoreError(`step ${pause.step} (${pause.nodeId}): ${r.rejected}`);
    }
    events.push(...r.events);
  }
  // Only continue from a history that reproduces exactly. Steps past the recording are
  // the automatic ones (compute, conditions) that follow the last answer deterministically.
  const restored = r.state.steps;
  restored.forEach((s, i) => {
    const want = perf.steps[i];
    if (!want) return;
    if (want.nodeId !== s.nodeId || want.stateHashAfter !== s.stateHashAfter) {
      throw new RestoreError(
        `recorded answers no longer reproduce the run at step ${s.step} (${s.nodeId}); fork from an earlier step`,
      );
    }
  });
  return { state: r.state, events };
}
