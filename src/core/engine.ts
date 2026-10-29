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
import { ENGINE_VERSION, RUN_SCHEMA_VERSION } from './migrate.js';
import { evalExpr, evaluateGuard, parseExpr } from './expr.js';
import { hashOf } from './hash.js';
import { solosActive, takesFor } from './jazz.js';
import { checkAgentResult, checkValue, validateUpdates, type Checked } from './schema.js';
import type {
  AcceptanceCheck,
  AgentNode,
  AgentPause,
  Complexity,
  AgentResolution,
  NodeResult,
  ToolPause,
  Recovery,
  RecoveryResolution,
  StuckPause,
  ToolResolution,
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
    readonly lowConfidence?: true;
    readonly transcript?: AiTranscript;
    /** The raw rejected answer, so replay can feed it back verbatim. */
    readonly result?: unknown;
    readonly at?: string;
  }[];
  /** Human decisions at the current step since it got stuck. */
  readonly recoveries: readonly Recovery[];
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

function follow(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  approved = true,
  chosen?: string,
): boolean {
  const edge = chosen
    ? score.edges.find((e) => e.id === chosen && e.from === node.id)
    : chooseEdge(score, ctx, node, approved);
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

/** node.complexity, else a state field `complexity` (1-4), else the score's. */
export function complexityFor(
  score: ExecutableScore,
  state: Readonly<Record<string, unknown>>,
  node: { readonly complexity?: Complexity; readonly complexityShift?: number },
): Complexity {
  if (node.complexity) return node.complexity;
  const fromState = state.complexity;
  const run =
    fromState === 1 || fromState === 2 || fromState === 3 || fromState === 4
      ? fromState
      : (score.complexity ?? 2);
  return Math.min(4, Math.max(1, run + (node.complexityShift ?? 0))) as Complexity;
}

function choicesOf(score: ExecutableScore, node: ScoreNode) {
  const label = (id: string) => score.nodes.find((n) => n.id === id)?.label ?? id;
  return score.edges
    .filter((e) => e.from === node.id)
    .map((e) => ({ edgeId: e.id, label: e.label ?? label(e.to), to: e.to }));
}

/** fanOut: the input of each parallel call, when the list splits into more than one chunk. */
function partsOf(
  node: AgentNode,
  state: Readonly<Record<string, unknown>>,
): { parts?: Readonly<Record<string, unknown>>[] } {
  if (!node.fanOut) return {};
  const list = state[node.fanOut.over];
  const per = typeof node.fanOut.per === 'number' ? node.fanOut.per : state[node.fanOut.per];
  if (!Array.isArray(list) || typeof per !== 'number' || per < 1) return {};
  const input = pick(state, node.reads);
  const parts: Readonly<Record<string, unknown>>[] = [];
  for (let i = 0; i < list.length; i += per) {
    parts.push({ ...input, [node.fanOut.over]: list.slice(i, i + per) });
  }
  return parts.length > 1 ? { parts } : {};
}

/**
 * fanOut answers: check each part, then merge them in part order (lists are
 * concatenated). A result without `parts` (a replayed, merged one) is checked as one.
 */
function checkParts(
  raw: unknown,
  pause: AgentPause,
  transcript: AiTranscript | undefined,
): Checked<NodeResult> | undefined {
  const parts = (raw as { parts?: unknown } | null | undefined)?.parts;
  if (!pause.parts || !Array.isArray(parts)) return undefined;
  if (parts.length !== pause.parts.length) {
    return {
      ok: false,
      errors: [`expected ${pause.parts.length} part results, got ${parts.length}`],
    };
  }
  const errors: string[] = [];
  const values: NodeResult[] = [];
  parts.forEach((p, i) => {
    const c: Checked<NodeResult> =
      p === undefined
        ? { ok: false, errors: [noResult(transcript?.parts?.[i])] }
        : checkAgentResult(p, pause.outputSchema);
    if (c.ok) values.push(c.value);
    else errors.push(...c.errors.map((e) => `part ${i + 1} of ${parts.length}: ${e}`));
  });
  if (errors.length > 0) return { ok: false, errors };
  const updates: Record<string, unknown> = {};
  for (const f of pause.outputSchema) {
    const lists = values.map((v) => v.updates[f.name]).filter(Array.isArray);
    if (lists.length > 0) updates[f.name] = lists.flat();
  }
  const outcomes = values.map((v) => v.verdict.outcome);
  return {
    ok: true,
    value: {
      updates,
      verdict: {
        outcome: outcomes.every((o) => o === 'applied')
          ? 'applied'
          : outcomes.includes('failed')
            ? 'failed'
            : 'skipped',
        confidence: Math.min(...values.map((v) => v.verdict.confidence)),
        shouldTerminate: values.some((v) => v.verdict.shouldTerminate),
        reason: values.map((v) => v.verdict.reason).join(' | '),
      },
    },
  };
}

/** One tier smarter for the re-check after a low-confidence answer. */
const escalate = (c: Complexity, up: boolean): Complexity =>
  up ? (Math.min(4, c + 1) as Complexity) : c;

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
      capabilities: node.capabilities ?? [],
      complexity: escalate(
        ctx.recoveries.findLast((r) => r.action === 'retry' && r.complexity)?.complexity ??
          complexityFor(score, ctx.state, node),
        ctx.attempts.some((a) => a.lowConfidence),
      ),
      improvisation: score.improvisation,
      isolated: node.isolated === true,
      ...(node.cites ? { cites: node.cites } : {}),
      ...(node.checks?.length ? { checks: node.checks } : {}),
      ...(node.otherModel ? { otherModel: true } : {}),
      ...partsOf(node, ctx.state),
      // Parallel parts already multiply the calls: a fanned-out step plays one take.
      takes: node.fanOut ? 1 : takesFor(score.improvisation, node.role),
      ...(node.solo && solosActive(score.improvisation) ? { choices: choicesOf(score, node) } : {}),
      attempt,
      // Each human retry grants a fresh budget; attempts keep counting so pause ids never repeat.
      maxAttempts:
        (1 + (node.retries ?? DEFAULT_RETRIES)) *
        (1 + ctx.recoveries.filter((r) => r.action === 'retry').length),
      ...(feedback ? { feedback } : {}),
      moveKey,
    };
  }
  if (node.kind === 'tool') {
    return {
      kind: 'tool',
      pauseId,
      step: ctx.step,
      nodeId: node.id,
      label: node.label,
      tool: node.tool,
      args: {
        ...node.args,
        ...Object.fromEntries(
          Object.entries(node.inputs ?? {}).map(([arg, f]) => [arg, ctx.state[f]]),
        ),
      },
      output: node.output,
      outputSchema: fieldsOf(score, Object.values(node.output)),
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
    shows: node.shows ?? [],
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
      case 'approval':
      case 'tool': {
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
    recoveries: [],
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
  const expected = st.pause.kind === 'stuck' ? 'recovery' : st.pause.kind;
  if (res.kind !== expected) {
    return fromCtx(ctx, `resolution kind '${res.kind}' does not match pause '${st.pause.kind}'`);
  }
  const node = nodeOf(score, st.pause.nodeId);
  if (res.kind === 'recovery') resolveRecovery(score, ctx, node, st.pause as StuckPause, res);
  else if (res.kind === 'agent')
    resolveAgent(score, ctx, node, st.pause as Extract<Pause, { kind: 'agent' }>, res);
  else if (res.kind === 'tool')
    resolveTool(score, ctx, node, st.pause as Extract<Pause, { kind: 'tool' }>, res);
  else resolveApproval(score, ctx, node, res);
  return fromCtx(ctx);
}

/** Map a tool's raw output (tool keys) to state updates (state fields) through `output`. */
export function mapToolOutput(
  output: Readonly<Record<string, string>>,
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(output).map(([key, field]) => [field, raw[key]]));
}

function resolveTool(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  pause: ToolPause,
  res: ToolResolution,
): void {
  const hashBefore = stateHashOf(ctx.state, ctx.env);
  const updates = res.updates ?? {};
  const errors = res.error ? [res.error] : validateUpdates(updates, pause.outputSchema, true);
  if (errors.length > 0) {
    recordStep(
      ctx,
      node,
      {
        attempts: [{ errors, result: res.updates, ...(res.at ? { at: res.at } : {}) }],
        ...(res.at ? { at: res.at } : {}),
      },
      hashBefore,
    );
    fail(ctx, `tool '${pause.tool}' at '${node.id}' failed: ${errors.join('; ')}`, node.id, res.at);
    return;
  }
  const before = ctx.state;
  ctx.state = { ...before, ...structuredClone(updates) };
  const changes = diff(before, ctx.state);
  ctx.lastWrites = Object.keys(updates);
  ctx.pause = undefined;
  recordStep(ctx, node, { changes, updates, ...(res.at ? { at: res.at } : {}) }, hashBefore);
  emit(ctx, {
    type: 'node-completed',
    step: ctx.step,
    nodeId: node.id,
    changes,
    stateHash: stateHashOf(ctx.state, ctx.env),
  });
  ctx.completedAt = res.at ?? ctx.completedAt;
  if (follow(score, ctx, node)) drive(score, ctx);
}

/** Evaluate acceptance checks against state as it would be after applying the answer. */
/** A step's own checks on its answer, evaluated against the state it would produce. */
export function acceptance(
  checks: readonly AcceptanceCheck[],
  state: Readonly<Record<string, unknown>>,
  value: NodeResult,
): Checked<NodeResult> {
  const scope = { ...state, ...value.updates, verdict: value.verdict };
  const errors: string[] = [];
  for (const c of checks) {
    try {
      if (!evaluateGuard(c.expr, scope)) errors.push(`${c.message} (check failed: ${c.expr})`);
    } catch (e) {
      errors.push(`${c.message} (check '${c.expr}' errored: ${(e as Error).message})`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function resolveRecovery(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  pause: StuckPause,
  res: RecoveryResolution,
): void {
  const { kind: _k, pauseId: _p, ...decision } = res;
  ctx.recoveries = [...ctx.recoveries, decision];
  emit(ctx, { type: 'recovered', step: ctx.step, nodeId: node.id, recovery: decision });
  if (res.action === 'stop') {
    const hashBefore = stateHashOf(ctx.state, ctx.env);
    const input = node.kind === 'agent' ? pick(ctx.state, node.reads) : {};
    recordStep(
      ctx,
      node,
      { input, attempts: ctx.attempts, recoveries: ctx.recoveries, at: res.at },
      hashBefore,
    );
    fail(
      ctx,
      `'${node.id}' gave no valid response after ${ctx.attempts.length} attempt(s): ${pause.feedback.join('; ')}`,
      node.id,
      res.at,
    );
    return;
  }
  const feedback = [
    ...pause.feedback,
    ...(res.hint?.trim()
      ? [`A human looked at your previous answers and says: ${res.hint.trim()}`]
      : []),
  ];
  const next = makePause(score, ctx, node, ctx.attempts.length + 1, feedback);
  ctx.pause = next;
  emit(ctx, { type: 'paused', pause: next });
}

/**
 * Why an AI step gave no result at all, from what it said: a "result must be an
 * object" error would hide that the provider blocked the answer or the AI stopped.
 */
export function isProviderBlock(output: string): boolean {
  return /content filter|blocked by|content management policy|responsible ai/i.test(output);
}

export function noResult(transcript: AiTranscript | undefined): string {
  const said = transcript?.output.trim() ?? '';
  if (isProviderBlock(said)) {
    return `no result: the AI provider blocked the response ("${said.slice(0, 200)}"). The same model usually blocks the same prompt again: retry at another tier (a different model), or with a hint.`;
  }
  return said
    ? `no result: the AI ended without calling submit_result. It last said: "${said.slice(-300)}"`
    : 'no result: the AI ended without calling submit_result and wrote nothing (it may have hit a limit or timed out).';
}

/** A valid answer the step asks to re-check once, because the AI was not confident. */
function lowConfidence(
  node: ScoreNode,
  ctx: Ctx,
  pause: AgentPause,
  value: NodeResult,
): string | undefined {
  if (node.kind !== 'agent' || node.verifyBelow === undefined) return undefined;
  const c = value.verdict.confidence;
  if (c >= node.verifyBelow || ctx.attempts.some((a) => a.lowConfidence)) return undefined;
  if (pause.attempt >= pause.maxAttempts) return undefined;
  return `You reported confidence ${c}, below ${node.verifyBelow} for this step. Re-check the claims you were least sure of against the evidence, fix or drop what does not hold, and answer again.`;
}

function resolveAgent(
  score: ExecutableScore,
  ctx: Ctx,
  node: ScoreNode,
  pause: Extract<Pause, { kind: 'agent' }>,
  res: AgentResolution,
): void {
  const routed: ReturnType<typeof checkAgentResult> =
    checkParts(res.result, pause, res.transcript) ??
    (res.result === undefined
      ? { ok: false, errors: [noResult(res.transcript)] }
      : checkAgentResult(res.result, pause.outputSchema, pause.choices));
  const accepted =
    routed.ok && node.kind === 'agent' && node.checks?.length
      ? acceptance(node.checks, ctx.state, routed.value)
      : routed;
  const doubt = accepted.ok ? lowConfidence(node, ctx, pause, accepted.value) : undefined;
  const checked: typeof accepted = doubt ? { ok: false, errors: [doubt] } : accepted;
  const hashBefore = stateHashOf(ctx.state, ctx.env);
  if (!checked.ok) {
    ctx.attempts = [
      ...ctx.attempts,
      {
        errors: checked.errors,
        ...(doubt ? { lowConfidence: true as const } : {}),
        result: res.result,
        ...(res.transcript ? { transcript: res.transcript } : {}),
        ...(res.at ? { at: res.at } : {}),
      },
    ];
    emit(ctx, {
      type: 'response-rejected',
      nodeId: node.id,
      attempt: pause.attempt,
      errors: checked.errors,
    });
    if (pause.attempt >= pause.maxAttempts) {
      // Out of attempts: ask a human instead of failing (a run without one answers 'stop').
      const stuck: StuckPause = {
        kind: 'stuck',
        pauseId: hashOf({
          scoreId: score.id,
          step: ctx.step,
          nodeId: node.id,
          stuck: ctx.recoveries.length,
        }).slice(0, 16),
        step: ctx.step,
        nodeId: node.id,
        label: node.label,
        feedback: checked.errors,
        attempts: ctx.attempts.length,
        complexity: pause.complexity,
        moveKey: pause.moveKey,
      };
      ctx.pause = stuck;
      emit(ctx, { type: 'paused', pause: stuck });
      return;
    }
    const next = makePause(score, ctx, node, pause.attempt + 1, checked.errors);
    ctx.pause = next;
    emit(ctx, { type: 'paused', pause: next });
    return;
  }
  const { updates, verdict } = checked.value;
  const next = pause.choices ? checked.value.next : undefined;
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
      ...(next ? { next } : {}),
      verdict,
      ...(ctx.attempts.length > 0 ? { attempts: ctx.attempts } : {}),
      ...(ctx.recoveries.length > 0 ? { recoveries: ctx.recoveries } : {}),
      ...(res.transcript ? { transcript: res.transcript } : {}),
      ...(res.at ? { at: res.at } : {}),
    },
    hashBefore,
  );
  ctx.attempts = [];
  ctx.recoveries = [];
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
  if (follow(score, ctx, node, true, next)) drive(score, ctx);
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
      ctx.attempts = [
        ...ctx.attempts,
        { errors, result: updates, ...(res.at ? { at: res.at } : {}) },
      ];
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
  const attempts = ctx.attempts;
  ctx.attempts = [];
  recordStep(
    ctx,
    node,
    {
      changes,
      updates,
      ...(attempts.length > 0 ? { attempts } : {}),
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
    schemaVersion: RUN_SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    scoreId: st.scoreId,
    startedAt: st.startedAt,
    ...(st.kind !== 'running' && st.completedAt ? { completedAt: st.completedAt } : {}),
    outcome: st.kind === 'running' ? 'in-progress' : st.outcome,
    ...(st.reason ? { reason: st.reason } : {}),
    finalState: st.state,
    steps: st.steps,
    events: st.events,
    ...(st.kind === 'running' && st.pause && st.attempts.length > 0
      ? { pending: { nodeId: st.pause.nodeId, step: st.pause.step, attempts: st.attempts } }
      : {}),
  };
}
