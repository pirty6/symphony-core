import { describe, expect, it } from 'vitest';
import { hangman } from '../patterns/hangman.js';
import { compileScore } from './compile.js';
import {
  advance,
  createEngine,
  toPerformance,
  type AdvanceResult,
  type EngineState,
} from './engine.js';
import { hashOf } from './hash.js';
import type { ExecutableScore, Pattern, Resolution } from './types.js';

const ok = (updates: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  updates,
  verdict: { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'ok', ...extra },
});

const score = compileScore(hangman, { goal: 'play', generatedAt: 't0' });

function answerAgent(s: ExecutableScore, r: AdvanceResult, result: unknown): AdvanceResult {
  const pause = r.state.pause!;
  return advance(s, r.state, { kind: 'agent', pauseId: pause.pauseId, result, at: 't' });
}

function guess(s: ExecutableScore, r: AdvanceResult, letter: string): AdvanceResult {
  const pause = r.state.pause!;
  return advance(s, r.state, {
    kind: 'approval',
    pauseId: pause.pauseId,
    approved: true,
    updates: { letter },
  });
}

function playWin(): AdvanceResult {
  let r = createEngine(score, { startedAt: 't0' });
  r = answerAgent(score, r, ok({ word: 'cat' }));
  for (const l of ['c', 'X', 'a', 't']) r = guess(score, r, l);
  return r;
}

describe('engine: hangman', () => {
  it('pauses at the agent node first', () => {
    const r = createEngine(score);
    expect(r.state.kind).toBe('running');
    expect(r.state.pause).toMatchObject({
      kind: 'agent',
      nodeId: 'pick',
      role: 'assessor',
      attempt: 1,
    });
    expect(r.events.map((e) => e.type)).toEqual([
      'run-started',
      'node-entered',
      'edge-taken',
      'node-entered',
      'paused',
    ]);
  });

  it('runs deterministic rules in code and wins', () => {
    const r = playWin();
    expect(r.state.kind).toBe('done');
    expect(r.state.outcome).toBe('success');
    expect(r.state.state).toMatchObject({
      word: 'cat',
      guessed: ['c', 'x', 'a', 't'],
      wrongCount: 1,
      won: true,
    });
    const perf = toPerformance(r.state);
    expect(perf.steps.at(-1)?.nodeId).toBe('win');
    expect(perf.events.filter((e) => e.type === 'guard-evaluated').length).toBeGreaterThan(0);
  });

  it('is deterministic: same inputs give byte-identical performances', () => {
    expect(hashOf(toPerformance(playWin().state))).toBe(hashOf(toPerformance(playWin().state)));
  });

  it('records carried data on edges', () => {
    let r = createEngine(score);
    r = answerAgent(score, r, ok({ word: 'cat' }));
    const edge = r.events.find((e) => e.type === 'edge-taken');
    expect(edge).toMatchObject({ edgeId: 'pick-ask', carried: ['word'], values: { word: 'cat' } });
  });

  it('loses after maxWrong misses', () => {
    let r = createEngine(score);
    r = answerAgent(score, r, ok({ word: 'cat' }));
    for (const l of ['q', 'w', 'e', 'r', 'y', 'u']) r = guess(score, r, l);
    expect(r.state.kind).toBe('done');
    expect(r.state.outcome).toBe('partial');
    expect(r.state.cursor).toBe('lose');
  });
});

describe('engine: response validation', () => {
  it('rejects bad shapes, re-asks with feedback, then accepts', () => {
    let r = createEngine(score);
    r = answerAgent(score, r, { updates: { word: 5 }, verdict: ok({}).verdict });
    expect(r.state.kind).toBe('running');
    expect(r.state.pause).toMatchObject({ nodeId: 'pick', attempt: 2 });
    expect(r.state.pause?.feedback?.[0]).toMatch(/updates.word: expected string/);
    expect(r.events[0]).toMatchObject({ type: 'response-rejected', attempt: 1 });
    r = answerAgent(score, r, ok({ word: 'dog' }));
    expect(r.state.pause).toMatchObject({ kind: 'approval', nodeId: 'ask' });
    expect(r.state.steps.find((s) => s.nodeId === 'pick')?.attempts).toHaveLength(1);
  });

  it('fails after exhausting retries without touching state', () => {
    let r = createEngine(score);
    for (let i = 0; i < 3; i += 1) r = answerAgent(score, r, 'not json');
    expect(r.state.kind).toBe('failed');
    expect(r.state.reason).toMatch(/no valid response after 3 attempt/);
    expect(r.state.state.word).toBe('');
  });

  it('refuses writes outside the node contract', () => {
    let r = createEngine(score);
    r = answerAgent(score, r, ok({ word: 'cat', won: true }));
    expect(r.state.pause?.feedback?.join()).toMatch(/updates.won is not writable/);
  });

  it('rejects stale or mismatched resolutions without changing state', () => {
    const r0 = createEngine(score);
    const stale = advance(score, r0.state, {
      kind: 'agent',
      pauseId: 'nope',
      result: ok({ word: 'cat' }),
    });
    expect(stale.rejected).toMatch(/stale or unknown pauseId/);
    expect(stale.state).toEqual(r0.state);
    const wrongKind = advance(score, r0.state, {
      kind: 'approval',
      pauseId: r0.state.pause!.pauseId,
      approved: true,
    });
    expect(wrongKind.rejected).toMatch(/does not match/);
    const r1 = answerAgent(score, r0, ok({ word: 'cat' }));
    const replayed = advance(score, r1.state, {
      kind: 'agent',
      pauseId: r0.state.pause!.pauseId,
      result: ok({ word: 'x' }),
    });
    expect(replayed.rejected).toBeDefined();
  });
});

describe('engine: loop safety', () => {
  it('refuses to repeat (moveType, targetSite, stateHash)', () => {
    let r = createEngine(score);
    r = answerAgent(score, r, ok({ word: 'ab' }));
    expect(r.state.pause?.nodeId).toBe('pick');
    r = answerAgent(score, r, ok({ word: 'ab' }));
    expect(r.state.kind).toBe('failed');
    expect(r.state.reason).toMatch(/repeat move refused: 'pick'/);
  });

  it('treats a changed workspace (envHash) as a new state', () => {
    let r = createEngine(score);
    r = advance(score, r.state, {
      kind: 'agent',
      pauseId: r.state.pause!.pauseId,
      result: ok({ word: 'ab' }),
      envHash: 'e1',
    });
    r = advance(score, r.state, {
      kind: 'agent',
      pauseId: r.state.pause!.pauseId,
      result: ok({ word: 'ab' }),
      envHash: 'e2',
    });
    expect(r.state.kind).toBe('running');
  });

  it('enforces maxVisits and maxSteps', () => {
    const tight: Pattern = {
      ...hangman,
      nodes: hangman.nodes.map((n) => (n.id === 'ask' ? { ...n, maxVisits: 2 } : n)),
    };
    const s = compileScore(tight, { goal: 'g' });
    let r = createEngine(s);
    r = answerAgent(s, r, ok({ word: 'cat' }));
    r = guess(s, r, 'q');
    r = guess(s, r, 'w');
    expect(r.state.kind).toBe('failed');
    expect(r.state.reason).toMatch(/exceeded maxVisits \(2\)/);

    const short = compileScore({ ...hangman, maxSteps: 2 }, { goal: 'g' });
    let q = createEngine(short);
    q = answerAgent(short, q, ok({ word: 'cat' }));
    expect(q.state.reason).toMatch(/maxSteps \(2\) exceeded/);
  });
});

describe('engine: approvals, termination, cancel', () => {
  it('re-asks the human when approval values are invalid', () => {
    let r = createEngine(score);
    r = answerAgent(score, r, ok({ word: 'cat' }));
    r = advance(score, r.state, {
      kind: 'approval',
      pauseId: r.state.pause!.pauseId,
      approved: true,
      updates: {},
    });
    expect(r.state.pause).toMatchObject({ kind: 'approval', nodeId: 'ask' });
    expect(r.state.pause?.feedback?.[0]).toMatch(/updates.letter is required/);
  });

  it('cancels when an approval is rejected with no rejected edge', () => {
    let r = createEngine(score);
    r = answerAgent(score, r, ok({ word: 'cat' }));
    r = advance(score, r.state, {
      kind: 'approval',
      pauseId: r.state.pause!.pauseId,
      approved: false,
    });
    expect(r.state).toMatchObject({ kind: 'done', outcome: 'cancelled' });
  });

  it('honours verdict.shouldTerminate', () => {
    const r = answerAgent(
      score,
      createEngine(score),
      ok({ word: 'cat' }, { shouldTerminate: true }),
    );
    expect(r.state).toMatchObject({ kind: 'done', outcome: 'success' });
  });

  it('supports cancel resolutions', () => {
    const r0 = createEngine(score);
    const cancel: Resolution = {
      kind: 'cancel',
      pauseId: r0.state.pause!.pauseId,
      reason: 'user stop',
    };
    expect(advance(score, r0.state, cancel).state).toMatchObject({
      kind: 'done',
      outcome: 'cancelled',
      reason: 'user stop',
    });
  });

  it('never mutates the previous engine state', () => {
    const r0 = createEngine(score);
    const snapshot: EngineState = structuredClone(r0.state);
    answerAgent(score, r0, ok({ word: 'cat' }));
    expect(r0.state).toEqual(snapshot);
  });
});
