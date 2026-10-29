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
          fanOut: { over: 'files', per: 'files' },
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
      ]),
    );
    expect(validatePattern(reader).errors).toEqual([]);
  });
});
