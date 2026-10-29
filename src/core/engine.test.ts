import { describe, expect, it } from 'vitest';
import { hangman } from '../patterns/hangman.js';
import { compileScore } from './compile.js';
import {
  advance,
  createEngine,
  mapToolOutput,
  toPerformance,
  type AdvanceResult,
  type EngineState,
} from './engine.js';
import { hashOf } from './hash.js';
import { replayPerformance } from './replay.js';
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

function recover(
  s: ExecutableScore,
  r: AdvanceResult,
  action: 'retry' | 'stop',
  extra: { hint?: string; complexity?: 1 | 2 | 3 | 4 } = {},
): AdvanceResult {
  return advance(s, r.state, {
    kind: 'recovery',
    pauseId: r.state.pause!.pauseId,
    action,
    ...extra,
  });
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

  it('no result at all says why: what the AI said, or that a provider filter blocked it', () => {
    const answer = (r: AdvanceResult, output: string) =>
      advance(score, r.state, {
        kind: 'agent',
        pauseId: r.state.pause!.pauseId,
        result: undefined,
        transcript: { provider: 'copilot', prompt: 'p', output, toolCalls: [] },
      });
    let r = answer(
      createEngine(score),
      'The model returned no content because the response was blocked by content filtering.',
    );
    expect(r.state.pause?.feedback?.[0]).toMatch(
      /^no result: the AI provider blocked the response .* retry at another tier \(a different model\)/,
    );
    r = answer(r, 'I read the files and think the word is cat.');
    expect(r.state.pause?.feedback?.[0]).toBe(
      'no result: the AI ended without calling submit_result. It last said: "I read the files and think the word is cat."',
    );
    r = answer(r, '');
    expect(r.state.pause).toMatchObject({ kind: 'stuck' });
    expect(r.state.pause?.feedback?.[0]).toMatch(
      /wrote nothing \(it may have hit a limit or timed out\)/,
    );
    // Saved while stuck, the run keeps what the AI said in each attempt.
    const pending = toPerformance(r.state).pending!;
    expect(pending.nodeId).toBe('pick');
    expect(pending.attempts.map((a) => a.transcript?.output)).toEqual([
      'The model returned no content because the response was blocked by content filtering.',
      'I read the files and think the word is cat.',
      '',
    ]);
    expect(pending.attempts[0]!.errors[0]).toMatch(/blocked the response/);
  });

  it('gets stuck after exhausting retries; stopping fails without touching state', () => {
    let r = createEngine(score);
    for (let i = 0; i < 3; i += 1) r = answerAgent(score, r, 'not json');
    expect(r.state.kind).toBe('running');
    expect(r.state.pause).toMatchObject({ kind: 'stuck', nodeId: 'pick', attempts: 3 });
    expect(r.state.pause?.feedback?.[0]).toMatch(/result must be an object/);
    // The stuck pause takes only a recovery decision.
    expect(answerAgent(score, r, ok({ word: 'cat' })).rejected).toMatch(
      /does not match pause 'stuck'/,
    );
    r = recover(score, r, 'stop');
    expect(r.state.kind).toBe('failed');
    expect(r.state.reason).toMatch(/no valid response after 3 attempt/);
    expect(r.state.state.word).toBe('');
    expect(r.state.steps.at(-1)).toMatchObject({
      nodeId: 'pick',
      recoveries: [{ action: 'stop' }],
    });
  });

  it('a retry gets a fresh budget, the hint and the chosen tier, then completes', () => {
    let r = createEngine(score);
    for (let i = 0; i < 3; i += 1) r = answerAgent(score, r, 'not json');
    const stuckId = r.state.pause!.pauseId;
    r = recover(score, r, 'retry', { hint: 'answer with one lowercase word', complexity: 4 });
    expect(r.state.pause).toMatchObject({
      kind: 'agent',
      attempt: 4,
      maxAttempts: 6,
      complexity: 4,
    });
    expect(r.state.pause?.feedback?.at(-1)).toMatch(
      /A human .* says: answer with one lowercase word/,
    );
    expect(r.events.map((e) => e.type)).toEqual(['recovered', 'paused']);
    // Attempts keep counting, so no pause id repeats.
    const ids = r.state.events.flatMap((e) => (e.type === 'paused' ? [e.pause.pauseId] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(stuckId);
    r = answerAgent(score, r, ok({ word: 'cat' }));
    expect(r.state.pause).toMatchObject({ kind: 'approval', nodeId: 'ask' });
    const pick = r.state.steps.find((s) => s.nodeId === 'pick')!;
    expect(pick.attempts).toHaveLength(3);
    expect(pick.recoveries).toEqual([
      { action: 'retry', hint: 'answer with one lowercase word', complexity: 4 },
    ]);
    // A later step starts clean.
    expect(r.state.recoveries).toEqual([]);
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

describe('engine: acceptance checks', () => {
  const coverage: Pattern = {
    name: 'cover',
    description: 'cover every item',
    requiredContext: [],
    state: [
      { name: 'batch', type: 'string[]', initial: ['a.ts', 'b.ts'] },
      { name: 'covered', type: 'string[]' },
    ],
    start: 's',
    nodes: [
      { id: 's', kind: 'start', label: 'S' },
      {
        id: 'look',
        kind: 'agent',
        role: 'assessor',
        label: 'Look',
        directive: 'report on every file',
        reads: ['batch'],
        writes: ['covered'],
        retries: 1,
        capabilities: ['web'],
        checks: [{ expr: 'subset(batch, covered)', message: 'Report on every file in batch' }],
      },
      { id: 'e', kind: 'end', label: 'E' },
    ],
    edges: [
      { id: '1', from: 's', to: 'look' },
      { id: '2', from: 'look', to: 'e' },
    ],
  };
  const s = compileScore(coverage, { goal: 'g' });

  it('passes capabilities to the pause', () => {
    expect(createEngine(s).state.pause).toMatchObject({ capabilities: ['web'] });
  });

  it('rejects answers that skip items and re-asks with the rule', () => {
    let r = createEngine(s);
    r = answerAgent(s, r, ok({ covered: ['a.ts'] }));
    expect(r.state.pause).toMatchObject({ nodeId: 'look', attempt: 2 });
    expect(r.state.pause?.feedback?.[0]).toMatch(
      /Report on every file in batch \(check failed: subset\(batch, covered\)\)/,
    );
    expect(r.state.state.covered).toEqual([]);
    r = answerAgent(s, r, ok({ covered: ['b.ts', 'a.ts'] }));
    expect(r.state).toMatchObject({ kind: 'done', outcome: 'success' });
  });

  it('cannot be dodged by reporting failure', () => {
    let r = createEngine(s);
    r = answerAgent(s, r, ok({}, { outcome: 'skipped' }));
    r = answerAgent(s, r, ok({}, { outcome: 'failed' }));
    expect(r.state.pause?.kind).toBe('stuck');
    r = recover(s, r, 'stop');
    expect(r.state.kind).toBe('failed');
    expect(r.state.reason).toMatch(/Report on every file/);
  });
});

describe('engine: tool nodes', () => {
  const tooling: Pattern = {
    name: 'tooling',
    description: 'list then count',
    requiredContext: [],
    state: [
      { name: 'files', type: 'string[]' },
      { name: 'count', type: 'number' },
    ],
    start: 's',
    nodes: [
      { id: 's', kind: 'start', label: 'S' },
      { id: 'list', kind: 'tool', label: 'List', tool: 'repo.files', output: { files: 'files' } },
      {
        id: 'count',
        kind: 'compute',
        label: 'Count',
        assign: [{ field: 'count', expr: 'len(files)' }],
      },
      { id: 'e', kind: 'end', label: 'E' },
    ],
    edges: [
      { id: '1', from: 's', to: 'list' },
      { id: '2', from: 'list', to: 'count' },
      { id: '3', from: 'count', to: 'e' },
    ],
  };
  const s = compileScore(tooling, { goal: 'g' });

  it('pauses for the runtime and applies validated output', () => {
    const r0 = createEngine(s);
    expect(r0.state.pause).toMatchObject({
      kind: 'tool',
      tool: 'repo.files',
      output: { files: 'files' },
    });
    const r = advance(s, r0.state, {
      kind: 'tool',
      pauseId: r0.state.pause!.pauseId,
      updates: mapToolOutput({ files: 'files' }, { files: ['a', 'b'] }),
    });
    expect(r.state).toMatchObject({ kind: 'done', state: { files: ['a', 'b'], count: 2 } });
    expect(r.state.steps.find((st) => st.nodeId === 'list')?.updates).toEqual({
      files: ['a', 'b'],
    });
  });

  it('fails the run on tool errors or bad output (no retries: tools are code)', () => {
    const r0 = createEngine(s);
    const err = advance(s, r0.state, {
      kind: 'tool',
      pauseId: r0.state.pause!.pauseId,
      error: 'git missing',
    });
    expect(err.state).toMatchObject({
      kind: 'failed',
      reason: "tool 'repo.files' at 'list' failed: git missing",
    });
    const bad = advance(s, r0.state, {
      kind: 'tool',
      pauseId: r0.state.pause!.pauseId,
      updates: { files: 'nope' },
    });
    expect(bad.state.reason).toMatch(/updates.files: expected string\[\]/);
  });
});

describe('engine: complexity, solos and takes', () => {
  const jam: Pattern = {
    name: 'jam',
    description: 'explore then decide',
    requiredContext: [],
    state: [
      { name: 'notes', type: 'string[]' },
      { name: 'complexity', type: 'number' },
    ],
    start: 's',
    nodes: [
      { id: 's', kind: 'start', label: 'S' },
      {
        id: 'think',
        kind: 'agent',
        role: 'assessor',
        label: 'Think',
        directive: 'd',
        reads: [],
        writes: ['notes'],
        solo: true,
        maxVisits: 3,
      },
      {
        id: 'act',
        kind: 'agent',
        role: 'executor',
        label: 'Act',
        directive: 'd',
        reads: [],
        writes: [],
        complexity: 1,
      },
      { id: 'e', kind: 'end', label: 'E' },
    ],
    edges: [
      { id: 'again', from: 'think', to: 'think', label: 'think more' },
      { id: 'go', from: 'think', to: 'act', label: 'act now' },
      { id: '1', from: 's', to: 'think' },
      { id: '2', from: 'act', to: 'e' },
    ],
  };

  it('plays the written route below Swing and lets the AI solo from Swing up', () => {
    const classical = compileScore(jam, { goal: 'g', improvisation: 0 });
    let r = createEngine(classical);
    expect(r.state.pause).toMatchObject({
      takes: 1,
      improvisation: 0,
      complexity: 2,
    });
    expect(r.state.pause).not.toHaveProperty('choices');
    r = answerAgent(classical, r, ok({ notes: ['a'] }));
    expect(r.state.pause?.nodeId).toBe('think');

    const swing = compileScore(jam, { goal: 'g', improvisation: 2 });
    expect(swing.id).not.toBe(classical.id);
    let j = createEngine(swing);
    expect(j.state.pause?.kind === 'agent' && j.state.pause.choices).toEqual([
      { edgeId: 'again', label: 'think more', to: 'think' },
      { edgeId: 'go', label: 'act now', to: 'act' },
    ]);
    j = answerAgent(swing, j, ok({ notes: ['a'] }));
    expect(j.state.pause?.feedback?.[0]).toMatch(
      /This is a solo: 'next' must be one of 'again', 'go'/,
    );
    j = answerAgent(swing, j, { ...ok({ notes: ['a'] }), next: 'go' });
    expect(j.state.pause).toMatchObject({ nodeId: 'act', complexity: 1, takes: 1 });
    expect(j.state.steps.find((s) => s.nodeId === 'think')?.next).toBe('go');
    const perf = toPerformance(answerAgent(swing, j, ok({})).state);
    expect(replayPerformance(swing, perf).divergence.reproduced).toBe(true);
  });

  it('takes more takes for assessors at Bebop and Free, never for executors', () => {
    const bebop = compileScore(jam, { goal: 'g', improvisation: 3 });
    const r = createEngine(bebop);
    expect(r.state.pause).toMatchObject({ takes: 2 });
    const free = compileScore(jam, { goal: 'g', improvisation: 4, complexity: 4 });
    expect(createEngine(free).state.pause).toMatchObject({ takes: 3, complexity: 4 });
  });

  it('reads the tier from a complexity state field', () => {
    const s = compileScore(jam, { goal: 'g', context: { complexity: 3 } });
    expect(createEngine(s).state.pause).toMatchObject({ complexity: 3 });
  });

  it('passes state values to tools through inputs', () => {
    const p: Pattern = {
      name: 'inp',
      description: 'd',
      requiredContext: [],
      state: [
        { name: 'q', type: 'string', initial: 'hello' },
        { name: 'out', type: 'string' },
      ],
      start: 's',
      nodes: [
        { id: 's', kind: 'start', label: 'S' },
        {
          id: 't',
          kind: 'tool',
          label: 'T',
          tool: 'x',
          args: { n: 1 },
          inputs: { query: 'q' },
          output: { r: 'out' },
        },
        { id: 'e', kind: 'end', label: 'E' },
      ],
      edges: [
        { id: '1', from: 's', to: 't' },
        { id: '2', from: 't', to: 'e' },
      ],
    };
    expect(createEngine(compileScore(p, { goal: 'g' })).state.pause).toMatchObject({
      args: { n: 1, query: 'hello' },
    });
  });
});
