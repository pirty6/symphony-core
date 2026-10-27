import { describe, expect, it } from 'vitest';
import { CompileError, compileScore, verifyScore } from './compile.js';
import type { Pattern } from './types.js';

const pattern: Pattern = {
  name: 'tiny',
  description: 'one agent',
  requiredContext: ['topic'],
  state: [
    { name: 'topic', type: 'string' },
    { name: 'answer', type: 'string' },
    { name: 'tries', type: 'number', initial: 3 },
  ],
  start: 's',
  nodes: [
    { id: 's', kind: 'start', label: 'Start' },
    {
      id: 'a',
      kind: 'agent',
      role: 'assessor',
      label: 'Answer',
      directive: 'Answer about topic',
      reads: ['topic'],
      writes: ['answer'],
    },
    { id: 'e', kind: 'end', label: 'End' },
  ],
  edges: [
    { id: '1', from: 's', to: 'a' },
    { id: '2', from: 'a', to: 'e' },
  ],
  demo: { agents: {} },
};

describe('compileScore', () => {
  const args = { goal: 'explain', context: { topic: 'tides' }, generatedAt: 't0' };

  it('seeds initial state from context, initial and zero values', () => {
    const s = compileScore(pattern, args);
    expect(s.initialState).toEqual({ topic: 'tides', answer: '', tries: 3 });
    expect(s.maxSteps).toBe(100);
    expect('demo' in s).toBe(false);
  });

  it('is deterministic and ignores generatedAt in the id', () => {
    const a = compileScore(pattern, args);
    const b = compileScore(pattern, { ...args, generatedAt: 't1' });
    expect(a.id).toBe(b.id);
    expect(compileScore(pattern, { ...args, goal: 'other' }).id).not.toBe(a.id);
  });

  it('returns a deep-frozen score', () => {
    const s = compileScore(pattern, args);
    expect(Object.isFrozen(s.nodes[1])).toBe(true);
    expect(() => {
      (s.initialState as Record<string, unknown>).topic = 'x';
    }).toThrow();
  });

  it('rejects missing/unknown/mistyped context', () => {
    const run = (context: Record<string, unknown>) => () =>
      compileScore(pattern, { goal: 'g', context });
    expect(run({})).toThrow(/missing required context 'topic'/);
    expect(run({ topic: 't', bogus: 1 })).toThrow(/'bogus' is not a state field/);
    expect(run({ topic: 5 })).toThrow(CompileError);
  });

  it('takes the goal from the goalFrom input, ignoring any other goal', () => {
    const asks = { ...pattern, goalFrom: 'topic' };
    expect(compileScore(asks, { context: { topic: ' tides ' } }).goal).toBe('tides');
    expect(compileScore(asks, { goal: 'other', context: { topic: 'tides' } }).goal).toBe('tides');
    expect(() => compileScore(asks, { context: {} })).toThrow(/missing required context 'topic'/);
    expect(() => compileScore(pattern, { context: { topic: 't' } })).toThrow(/goal is required/);
    expect(() =>
      compileScore({ ...pattern, goalFrom: 'nope' }, { context: { topic: 't' } }),
    ).toThrow(/goalFrom 'nope' must be a required string input/);
  });

  it('verifyScore detects tampering', () => {
    const s = compileScore(pattern, args);
    expect(verifyScore(s)).toEqual([]);
    const tampered = { ...structuredClone(s), goal: 'changed' };
    expect(verifyScore(tampered)[0]?.message).toMatch(/score id mismatch/);
  });
});
