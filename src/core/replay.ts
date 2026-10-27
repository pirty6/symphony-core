/**
 * Replay and visualization helpers over the engine's event log. Pure.
 *
 *   reduceFrame(frame, event) — incremental view model (live runs)
 *   framesOf(events)          — full timeline (scrubbing saved runs)
 *   replayPerformance(score, perf) — re-run the engine on recorded answers
 *   divergence(a, b)          — compare two performances
 */
import { advance, createEngine, type AdvanceResult } from './engine.js';
import type {
  EngineEvent,
  ExecutableScore,
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
  if (step.kind === 'agent' && step.verdict) {
    return {
      kind: 'agent',
      pauseId,
      result: { updates: step.updates ?? {}, verdict: step.verdict },
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
export function replayPerformance(
  score: ExecutableScore,
  perf: Performance,
): { readonly result: AdvanceResult; readonly divergence: Divergence } {
  let r = createEngine(score, { startedAt: perf.startedAt });
  const fed = new Map<number, number>();
  while (r.state.kind === 'running' && r.state.pause) {
    const pause = r.state.pause;
    const recorded = perf.steps.find((s) => s.step === pause.step && s.nodeId === pause.nodeId);
    const n = fed.get(pause.step) ?? 0;
    fed.set(pause.step, n + 1);
    const res = recorded ? resolutionFrom(recorded, pause.pauseId, n) : undefined;
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
    schemaVersion: 2,
    scoreId: r.state.scoreId,
    startedAt: r.state.startedAt,
    outcome: r.state.kind === 'running' ? 'in-progress' : r.state.outcome,
    finalState: r.state.state,
    steps: r.state.steps,
    events: r.state.events,
  };
  return { result: r, divergence: divergence(perf, replayed) };
}
