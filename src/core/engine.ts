/**
 * The engine: a pure reducer over an ExecutableScore.
 *
 *   createEngine(score)                 -> { state, events }
 *   advance(score, state, resolution)   -> { state, events }
 *
 * No I/O, no clocks, no randomness: timestamps arrive on resolutions and
 * pause ids are content hashes. Deterministic nodes (start, condition,
 * compute, end) run inside the engine; it pauses only where outside input
 * is needed (agent = AI, approval = human).
 *
 * Guards enforced here:
 *   - pauseId / kind must match the open pause (stale or duplicate input is rejected)
 *   - every agent response is shape-validated before it touches state
 *   - a move (moveType, targetSite, stateHash) is never repeated
 *   - per-node maxVisits and per-score maxSteps bound every loop
 */
import { evalExpr, evaluateGuard, parseExpr } from './expr.js';
import { hashOf } from './hash.js';
import { checkValue, validateNodeResult, validateUpdates } from './schema.js';
import type {
  AgentResolution,
  AiTranscript,
  ApprovalResolution,
  EngineEvent,
  ExecutableScore,
  MoveVerdict,
  Pause,
  Performance,
  PerformanceOutcome,
  PerformedStep,
  Resolution,
  ScoreEdge,
  ScoreNode,
  StateChange,
  StateField,
} from './types.js';

export const DEFAULT_RETRIES = 1;

export interface EngineState {
  readonly kind: 'running' | 'done' | 'failed';
  readonly scoreId: string;
  readonly cursor: string;
  readonly step: number;
  readonly state: Readonly<Record<string, unknown>>;
  /** Latest workspace fingerprint reported by the driver ('' if none). */
  readonly env: string;
  readonly visits: Readonly<Record<string, number>>;
  readonly seenMoves: readonly string[];
  readonly pause?: Pause;
  readonly attempts: readonly {
    readonly errors: readonly string[];
    readonly transcript?: AiTranscript;
  }[];
  readonly lastVerdict?: MoveVerdict;
  /** Keys written by the node just completed; they travel on the next edge. */
  readonly lastWrites: readonly string[];
  readonly steps: readonly PerformedStep[];
  readonly events: readonly EngineEvent[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: PerformanceOutcome;
  readonly reason?: string;
}

export interface AdvanceResult {
  readonly state: EngineState;
  /** Events emitted by this call only (also appended to state.events). */
  readonly events: readonly EngineEvent[];
  /** Set when the resolution was refused without changing state. */
  readonly rejected?: string;
}

// ── helpers ────────────────────────────────────────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Ctx = Mutable<EngineState> & { emitted: EngineEvent[] };

function emit(ctx: Ctx, e: EngineEvent): void {
  ctx.emitted.push(e);
  ctx.events = [...ctx.events, e];
}

function nodeOf(score: ExecutableScore, id: string): ScoreNode {
  const n = score.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node '${id}' not in score`);
  return n;
}

function fieldsOf(score: ExecutableScore, keys: readonly string[]): StateField[] {
  return keys.map((k) => score.state.find((f) => f.name === k)!).filter(Boolean);
}

function pick(
  state: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in state).map((k) => [k, state[k]]));
}

function diff(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): StateChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => hashOf(before[k]) !== hashOf(after[k]))
    .map((k) => ({ key: k, before: before[k], after: after[k] }));
}

export function stateHashOf(state: Readonly<Record<string, unknown>>, env: string): string {
  return hashOf({ state, env });
}

export function moveKeyOf(node: ScoreNode, stateHash: string): string {
  const moveType = node.kind === 'agent' ? `agent:${node.role}` : node.kind;
  return hashOf({ moveType, targetSite: node.id, stateHash });
}

function guardScope(ctx: Ctx): Record<string, unknown> {
  return { ...ctx.state, verdict: ctx.lastVerdict ?? null };
}

function finish(ctx: Ctx, outcome: PerformanceOutcome, reason: string, at?: string): void {
  ctx.kind = 'done';
  ctx.pause = undefined;
  ctx.outcome = outcome;
  ctx.reason = reason;
  ctx.completedAt = at ?? ctx.completedAt;
  emit(ctx, { type: 'run-completed', outcome, reason });
}

function fail(ctx: Ctx, error: string, nodeId?: string, at?: string): void {
  ctx.kind = 'failed';
  ctx.pause = undefined;
  ctx.outcome = 'failed';
  ctx.reason = error;
  ctx.completedAt = at ?? ctx.completedAt;
  emit(ctx, nodeId ? { type: 'run-failed', error, nodeId } : { type: 'run-failed', error });
}

function recordStep(
  ctx: Ctx,
  node: ScoreNode,
  extra: Partial<PerformedStep>,
  hashBefore: string,
): void {
  const performed: PerformedStep = {
    step: ctx.step,
    nodeId: node.id,
    kind: node.kind,
    moveKey: moveKeyOf(node, hashBefore),
    stateHashBefore: hashBefore,
    stateHashAfter: stateHashOf(ctx.state, ctx.env),
    changes: [],
    ...extra,
  };
  ctx.steps = [...ctx.steps, performed];
}

/** Pick the outgoing edge; returns undefined (after failing ctx) when none applies. */
function chooseEdge(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  approved = true,
): ScoreEdge | undefined {
  const out = score.edges.filter((e) => e.from === node.id);
  if (node.kind === 'condition') {
    let result: boolean;
    try {
      result = evaluateGuard(node.expression, guardScope(ctx));
    } catch (e) {
      fail(ctx, `condition '${node.id}': ${(e as Error).message}`, node.id);
      return undefined;
    }
    emit(ctx, { type: 'guard-evaluated', nodeId: node.id, expression: node.expression, result });
    return out.find((e) => e.branch === (result ? 'then' : 'else'));
  }
  const candidates =
    node.kind === 'approval'
      ? out.filter((e) => (approved ? e.branch !== 'rejected' : e.branch === 'rejected'))
      : out;
  for (const e of candidates) {
    if (e.guard === undefined) return e;
    let result: boolean;
    try {
      result = evaluateGuard(e.guard, guardScope(ctx));
    } catch (err) {
      fail(ctx, `guard on edge '${e.id}': ${(err as Error).message}`, node.id);
      return undefined;
    }
    emit(ctx, {
      type: 'guard-evaluated',
      nodeId: node.id,
      edgeId: e.id,
      expression: e.guard,
      result,
    });
    if (result) return e;
  }
  return undefined;
}

function follow(score: ExecutableScore, ctx: Ctx, node: ScoreNode, approved = true): boolean {
  const edge = chooseEdge(score, ctx, node, approved);
  if (ctx.kind !== 'running') return false;
  if (!edge) {
    if (node.kind === 'approval' && !approved) {
      finish(ctx, 'cancelled', `rejected at '${node.id}'`);
      return false;
    }
    fail(ctx, `no transition from '${node.id}': no guard matched and no default edge`, node.id);
    return false;
  }
  emit(ctx, {
    type: 'edge-taken',
    edgeId: edge.id,
    from: edge.from,
    to: edge.to,
    carried: ctx.lastWrites,
    values: pick(ctx.state, ctx.lastWrites),
  });
  ctx.cursor = edge.to;
  return true;
}

function makePause(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  attempt: number,
  feedback?: string[],
): Pause {
  const hashBefore = stateHashOf(ctx.state, ctx.env);
  const moveKey = moveKeyOf(node, hashBefore);
  const pauseId = hashOf({ scoreId: score.id, step: ctx.step, nodeId: node.id, attempt }).slice(
    0,
    16,
  );
  if (node.kind === 'agent') {
    return {
      kind: 'agent',
      pauseId,
      step: ctx.step,
      nodeId: node.id,
      role: node.role,
      label: node.label,
      directive: node.directive,
      goal: score.goal,
      context: score.context,
      input: pick(ctx.state, node.reads),
      outputSchema: fieldsOf(score, node.writes),
      attempt,
      maxAttempts: 1 + (node.retries ?? DEFAULT_RETRIES),
      ...(feedback ? { feedback } : {}),
      moveKey,
    };
  }
  if (node.kind !== 'approval') throw new Error(`cannot pause at ${node.kind}`);
  return {
    kind: 'approval',
    pauseId,
    step: ctx.step,
    nodeId: node.id,
    label: node.label,
    message: node.message,
    state: ctx.state,
    outputSchema: fieldsOf(score, node.writes),
    ...(feedback ? { feedback } : {}),
    moveKey,
  };
}

/** Run deterministic nodes until a pause or a terminal state. */
function drive(score: ExecutableScore, ctx: Ctx): void {
  while (ctx.kind === 'running') {
    const node = nodeOf(score, ctx.cursor);
    if (ctx.step >= score.maxSteps) {
      fail(ctx, `maxSteps (${score.maxSteps}) exceeded`, node.id);
      return;
    }
    const visits = (ctx.visits[node.id] ?? 0) + 1;
    if (node.maxVisits !== undefined && visits > node.maxVisits) {
      fail(ctx, `node '${node.id}' exceeded maxVisits (${node.maxVisits})`, node.id);
      return;
    }
    const hashBefore = stateHashOf(ctx.state, ctx.env);
    const moveKey = moveKeyOf(node, hashBefore);
    if (ctx.seenMoves.includes(moveKey)) {
      fail(
        ctx,
        `repeat move refused: '${node.id}' (${node.kind}) with an identical state would loop forever`,
        node.id,
      );
      return;
    }
    ctx.seenMoves = [...ctx.seenMoves, moveKey];
    ctx.visits = { ...ctx.visits, [node.id]: visits };
    ctx.step += 1;
    emit(ctx, {
      type: 'node-entered',
      step: ctx.step,
      nodeId: node.id,
      kind: node.kind,
      stateHash: hashBefore,
      moveKey,
    });

    switch (node.kind) {
      case 'start':
      case 'condition':
        ctx.lastWrites = node.kind === 'start' ? Object.keys(ctx.state) : [];
        recordStep(ctx, node, {}, hashBefore);
        if (!follow(score, ctx, node)) return;
        break;
      case 'compute': {
        const before = ctx.state;
        const next: Record<string, unknown> = { ...ctx.state };
        for (const a of node.assign) {
          let value: unknown;
          try {
            value = evalExpr(parseExpr(a.expr), next);
          } catch (e) {
            fail(ctx, `compute '${node.id}' ${a.field}: ${(e as Error).message}`, node.id);
            return;
          }
          const field = score.state.find((f) => f.name === a.field)!;
          const err = checkValue(field.type, value);
          if (err) {
            fail(ctx, `compute '${node.id}' ${a.field}: ${err}`, node.id);
            return;
          }
          next[a.field] = value;
        }
        ctx.state = next;
        const changes = diff(before, next);
        ctx.lastWrites = node.assign.map((a) => a.field);
        recordStep(ctx, node, { changes }, hashBefore);
        emit(ctx, {
          type: 'node-completed',
          step: ctx.step,
          nodeId: node.id,
          changes,
          stateHash: stateHashOf(ctx.state, ctx.env),
        });
        if (!follow(score, ctx, node)) return;
        break;
      }
      case 'end':
        recordStep(ctx, node, {}, hashBefore);
        finish(ctx, node.outcome ?? 'success', `reached end '${node.id}'`);
        return;
      case 'agent':
      case 'approval': {
        ctx.attempts = [];
        const pause = makePause(score, ctx, node, 1);
        ctx.pause = pause;
        emit(ctx, { type: 'paused', pause });
        return;
      }
    }
  }
}

function toCtx(st: EngineState): Ctx {
  return { ...st, emitted: [] };
}

function fromCtx(ctx: Ctx, rejected?: string): AdvanceResult {
  const { emitted, ...state } = ctx;
  return rejected ? { state, events: emitted, rejected } : { state, events: emitted };
}

// ── public API ─────────────────────────────────────────────────────

export function createEngine(
  score: ExecutableScore,
  opts: { readonly startedAt?: string } = {},
): AdvanceResult {
  const ctx: Ctx = {
    kind: 'running',
    scoreId: score.id,
    cursor: score.start,
    step: 0,
    state: structuredClone(score.initialState) as Record<string, unknown>,
    env: '',
    visits: {},
    seenMoves: [],
    attempts: [],
    lastWrites: [],
    steps: [],
    events: [],
    startedAt: opts.startedAt ?? '',
    outcome: 'in-progress',
    emitted: [],
  };
  emit(ctx, {
    type: 'run-started',
    scoreId: score.id,
    state: ctx.state as Record<string, unknown>,
  });
  drive(score, ctx);
  return fromCtx(ctx);
}

export function advance(score: ExecutableScore, st: EngineState, res: Resolution): AdvanceResult {
  const ctx = toCtx(st);
  if (st.scoreId !== score.id) return fromCtx(ctx, 'resolution for a different score');
  if (st.kind !== 'running' || !st.pause) return fromCtx(ctx, `engine is ${st.kind}, not waiting`);
  if (res.pauseId !== st.pause.pauseId) {
    return fromCtx(ctx, `stale or unknown pauseId '${res.pauseId}' (open: '${st.pause.pauseId}')`);
  }
  if (res.kind === 'cancel') {
    finish(ctx, 'cancelled', res.reason || 'cancelled', res.at);
    return fromCtx(ctx);
  }
  if (res.kind !== st.pause.kind) {
    return fromCtx(ctx, `resolution kind '${res.kind}' does not match pause '${st.pause.kind}'`);
  }
  const node = nodeOf(score, st.pause.nodeId);
  if (res.kind === 'agent')
    resolveAgent(score, ctx, node, st.pause as Extract<Pause, { kind: 'agent' }>, res);
  else resolveApproval(score, ctx, node, res);
  return fromCtx(ctx);
}

function resolveAgent(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  pause: Extract<Pause, { kind: 'agent' }>,
  res: AgentResolution,
): void {
  const checked = validateNodeResult(res.result, pause.outputSchema);
  const hashBefore = stateHashOf(ctx.state, ctx.env);
  if (!checked.ok) {
    ctx.attempts = [
      ...ctx.attempts,
      { errors: checked.errors, ...(res.transcript ? { transcript: res.transcript } : {}) },
    ];
    emit(ctx, {
      type: 'response-rejected',
      nodeId: node.id,
      attempt: pause.attempt,
      errors: checked.errors,
    });
    if (pause.attempt >= pause.maxAttempts) {
      recordStep(ctx, node, { input: pause.input, attempts: ctx.attempts, at: res.at }, hashBefore);
      fail(
        ctx,
        `'${node.id}' gave no valid response after ${pause.attempt} attempt(s): ${checked.errors.join('; ')}`,
        node.id,
        res.at,
      );
      return;
    }
    const next = makePause(score, ctx, node, pause.attempt + 1, checked.errors);
    ctx.pause = next;
    emit(ctx, { type: 'paused', pause: next });
    return;
  }
  const { updates, verdict } = checked.value;
  const before = ctx.state;
  ctx.state = { ...before, ...structuredClone(updates) };
  if (res.envHash !== undefined) ctx.env = res.envHash;
  const changes = diff(before, ctx.state);
  ctx.lastVerdict = verdict;
  ctx.lastWrites = Object.keys(updates);
  ctx.pause = undefined;
  recordStep(
    ctx,
    node,
    {
      input: pause.input,
      changes,
      updates,
      ...(res.envHash !== undefined ? { envHash: res.envHash } : {}),
      verdict,
      ...(ctx.attempts.length > 0 ? { attempts: ctx.attempts } : {}),
      ...(res.transcript ? { transcript: res.transcript } : {}),
      ...(res.at ? { at: res.at } : {}),
    },
    hashBefore,
  );
  ctx.attempts = [];
  emit(ctx, {
    type: 'node-completed',
    step: ctx.step,
    nodeId: node.id,
    changes,
    verdict,
    stateHash: stateHashOf(ctx.state, ctx.env),
  });
  if (verdict.shouldTerminate) {
    const outcome =
      verdict.outcome === 'applied'
        ? 'success'
        : verdict.outcome === 'failed'
          ? 'failed'
          : 'partial';
    finish(ctx, outcome, `'${node.id}' terminated: ${verdict.reason}`, res.at);
    return;
  }
  ctx.completedAt = res.at ?? ctx.completedAt;
  if (follow(score, ctx, node)) drive(score, ctx);
}

function resolveApproval(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  res: ApprovalResolution,
): void {
  const pause = ctx.pause as Extract<Pause, { kind: 'approval' }>;
  const updates = res.approved ? (res.updates ?? {}) : {};
  if (res.approved) {
    const errors = validateUpdates(updates, pause.outputSchema, true);
    if (errors.length > 0) {
      emit(ctx, {
        type: 'response-rejected',
        nodeId: node.id,
        attempt: ctx.attempts.length + 1,
        errors,
      });
      ctx.attempts = [...ctx.attempts, { errors }];
      const next = makePause(score, ctx, node, ctx.attempts.length + 1, errors);
      ctx.pause = next;
      emit(ctx, { type: 'paused', pause: next });
      return;
    }
  }
  const hashBefore = stateHashOf(ctx.state, ctx.env);
  const before = ctx.state;
  ctx.state = { ...before, ...structuredClone(updates) };
  const changes = diff(before, ctx.state);
  ctx.lastWrites = Object.keys(updates);
  ctx.lastVerdict = {
    outcome: res.approved ? 'applied' : 'skipped',
    confidence: 1,
    shouldTerminate: false,
    reason: res.approved ? 'approved by human' : 'rejected by human',
  };
  ctx.pause = undefined;
  ctx.attempts = [];
  recordStep(
    ctx,
    node,
    {
      changes,
      updates,
      approval: { approved: res.approved, ...(res.by ? { by: res.by } : {}) },
      ...(res.at ? { at: res.at } : {}),
    },
    hashBefore,
  );
  emit(ctx, {
    type: 'node-completed',
    step: ctx.step,
    nodeId: node.id,
    changes,
    stateHash: stateHashOf(ctx.state, ctx.env),
  });
  ctx.completedAt = res.at ?? ctx.completedAt;
  if (follow(score, ctx, node, res.approved)) drive(score, ctx);
}

export function toPerformance(st: EngineState): Performance {
  return {
    schemaVersion: 2,
    scoreId: st.scoreId,
    startedAt: st.startedAt,
    ...(st.kind !== 'running' && st.completedAt ? { completedAt: st.completedAt } : {}),
    outcome: st.kind === 'running' ? 'in-progress' : st.outcome,
    ...(st.reason ? { reason: st.reason } : {}),
    finalState: st.state,
    steps: st.steps,
    events: st.events,
  };
}
