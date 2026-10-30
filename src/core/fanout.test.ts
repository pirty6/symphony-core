import { describe, expect, it } from 'vitest';
import { compileScore } from './compile.js';
import { advance, createEngine, toPerformance, type AdvanceResult } from './engine.js';
import { replayPerformance } from './replay.js';
import type { AgentPause, Pattern } from './types.js';
import { validatePattern } from './validate.js';

const reader: Pattern = {
  name: 'reader',
  description: 'reads files in parallel parts',
  requiredContext: ['files'],
  state: [
    { name: 'files', type: 'string[]' },
    { name: 'per', type: 'number', initial: 2 },
    { name: 'read', type: 'string[]' },
    { name: 'notes', type: 'string[]' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'readAll',
      kind: 'agent',
      role: 'assessor',
      label: 'Read',
      directive: 'read every file',
      reads: ['files'],
      writes: ['read', 'notes'],
      fanOut: { over: 'files', per: 'per' },
      checks: [{ expr: 'subset(files, read)', message: 'Read every file.' }],
    },
    { id: 'end', kind: 'end', label: 'End', outcome: 'success' },
  ],
  edges: [
    { id: 'a', from: 'start', to: 'readAll' },
    { id: 'b', from: 'readAll', to: 'end' },
  ],
};

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});
const answer = (files: string[], confidence = 0.9) => ({
  updates: { read: files, notes: files.map((f) => `${f}: ok`) },
  verdict: v(`read ${files.join(',')}`, confidence),
});
const score = compileScore(reader, {
  goal: 'g',
  context: { files: ['a', 'b', 'c', 'd', 'e'] },
  generatedAt: 't',
});
const submit = (r: AdvanceResult, result: unknown) =>
  advance(score, r.state, { kind: 'agent', pauseId: r.state.pause!.pauseId, result, at: 't' });

describe('fanOut: one AI call per chunk, merged in chunk order', () => {
  it('splits the list into parts and merges the answers in part order', () => {
    const r = createEngine(score, { startedAt: 't' });
    const pause = r.state.pause as AgentPause;
    expect(pause.parts?.map((p) => p.files)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(pause.takes).toBe(1);
    const done = submit(r, {
      parts: [answer(['a', 'b']), answer(['c', 'd'], 0.6), answer(['e'])],
    });
    expect(done.state.outcome).toBe('success');
    const step = done.state.steps.find((s) => s.nodeId === 'readAll')!;
    expect(step.updates).toEqual({
      read: ['a', 'b', 'c', 'd', 'e'],
      notes: ['a: ok', 'b: ok', 'c: ok', 'd: ok', 'e: ok'],
    });
    expect(step.verdict).toMatchObject({ outcome: 'applied', confidence: 0.6 });
    expect(step.verdict!.reason).toBe('read a,b | read c,d | read e');
    // The engine-held record replays exactly (as a merged answer).
    expect(replayPerformance(score, toPerformance(done.state)).divergence.reproduced).toBe(true);
  });

  it('names the part that was wrong, and checks run on the merged answer', () => {
    let r = createEngine(score, { startedAt: 't' });
    r = submit(r, { parts: [answer(['a', 'b']), { updates: { read: 'c' } }, answer(['e'])] });
    expect(r.state.pause?.feedback?.join('\n')).toMatch(/^part 2 of 3: /);
    r = submit(r, { parts: [answer(['a', 'b']), answer(['c']), answer(['e'])] });
    expect(r.state.pause?.feedback?.[0]).toMatch(/^Read every file\./);
    const short = submit(createEngine(score, { startedAt: 't' }), { parts: [answer(['a', 'b'])] });
    expect(short.state.pause?.feedback).toEqual(['expected 3 part results, got 1']);
  });

  it('a retry plays only the parts that failed, keeping the ones that passed', () => {
    let r = createEngine(score, { startedAt: 't' });
    // Part 2 is malformed; part 3 misses a file of its chunk (its own check fails).
    r = submit(r, { parts: [answer(['a', 'b']), { updates: { read: 'c' } }, answer([])] });
    const retry = r.state.pause as AgentPause;
    expect(retry.partsDone?.map((p) => p?.updates.read ?? null)).toEqual([['a', 'b'], null, null]);
    // Only the missing parts are sent; the kept one fills its slot.
    const done = submit(r, { parts: [null, answer(['c', 'd']), answer(['e'])] });
    expect(done.state.outcome).toBe('success');
    expect(done.state.steps.find((st) => st.nodeId === 'readAll')!.updates).toMatchObject({
      read: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(replayPerformance(score, toPerformance(done.state)).divergence.reproduced).toBe(true);
  });

  it('keeps nothing when every part passed but the merged answer was rejected', () => {
    const doubting = compileScore(
      {
        ...reader,
        nodes: reader.nodes.map((n) => (n.id === 'readAll' ? { ...n, verifyBelow: 0.8 } : n)),
      },
      { goal: 'g', context: { files: ['a', 'b', 'c'] }, generatedAt: 't' },
    );
    let r = createEngine(doubting, { startedAt: 't' });
    r = advance(doubting, r.state, {
      kind: 'agent',
      pauseId: r.state.pause!.pauseId,
      result: { parts: [answer(['a', 'b'], 0.5), answer(['c'])] },
      at: 't',
    });
    expect((r.state.pause as AgentPause).partsDone).toBeUndefined();
  });

  it('plays as many parts at once as the agents field says, at most 6', () => {
    const agents = (n: number) =>
      compileScore(
        {
          ...reader,
          state: [...reader.state, { name: 'agents', type: 'number', initial: n }],
          nodes: reader.nodes.map((x) =>
            x.id === 'readAll' ? { ...x, fanOut: { over: 'files', per: 1, agents: 'agents' } } : x,
          ),
        },
        { goal: 'g', context: { files: ['a', 'b', 'c'] }, generatedAt: 't' },
      );
    const parallel = (n: number) => (createEngine(agents(n)).state.pause as AgentPause).parallel;
    expect(parallel(2)).toBe(2);
    expect(parallel(40)).toBe(6);
    expect(parallel(0)).toBe(1);
  });

  it('a list that fits in one chunk is a single ordinary call', () => {
    const one = compileScore(reader, { goal: 'g', context: { files: ['a'] }, generatedAt: 't' });
    expect((createEngine(one).state.pause as AgentPause).parts).toBeUndefined();
  });

  it('is validated: the list must be read, per must be a number, writes must be lists', () => {
    const node = reader.nodes[1]!;
    const broken: Pattern = {
      ...reader,
      state: [...reader.state, { name: 'summary', type: 'string' }],
      nodes: [
        reader.nodes[0]!,
        {
          ...node,
          reads: [],
          writes: ['read', 'summary'],
          fanOut: { over: 'files', per: 'files', agents: 'summary' },
        } as typeof node,
        reader.nodes[2]!,
      ],
    };
    const messages = validatePattern(broken).errors.map((e) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "fanOut.over 'files' must be a list field it reads",
        'fanOut.per must be a positive whole number or a number field',
        "fanOut steps merge lists: 'summary' must be a list field",
        "fanOut.agents 'summary' must be a number field",
      ]),
    );
    expect(validatePattern(reader).errors).toEqual([]);
  });
});
