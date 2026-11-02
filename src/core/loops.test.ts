import { describe, expect, it } from 'vitest';
import { hangman, investigate, PATTERNS } from '../patterns/index.js';
import { cycles, unboundedLoops } from './loops.js';
import type { Pattern, ScoreNode } from './types.js';
import { validatePattern } from './validate.js';

/** The pattern with one node changed. */
const editNode = (p: Pattern, id: string, edit: (n: ScoreNode) => ScoreNode): Pattern => ({
  ...p,
  nodes: p.nodes.map((n) => (n.id === id ? edit(n) : n)),
});
const uncapped = (n: ScoreNode): ScoreNode => {
  const { maxVisits: _m, visitsFrom: _v, ...rest } = n;
  return rest as ScoreNode;
};
const loopWarnings = (p: Pattern) =>
  validatePattern(p).warnings.filter((w) => w.message.startsWith('loop '));

const e = (from: string, to: string) => ({ from, to });

describe('cycles', () => {
  it('finds every cycle, self-loops included, and nothing acyclic', () => {
    expect(
      cycles(['a', 'b', 'c', 'd'], [e('a', 'b'), e('b', 'c'), e('c', 'b'), e('d', 'd')]),
    ).toEqual([['b', 'c'], ['d']]);
    expect(cycles(['a', 'b'], [e('a', 'b')])).toEqual([]);
  });
});

describe('every loop is bounded (a warning when not)', () => {
  it('the whole library passes', () => {
    for (const p of PATTERNS) expect(loopWarnings(p), p.name).toEqual([]);
  });

  it("flags hangman's pick → pick self-loop without its cap", () => {
    const w = loopWarnings(editNode(hangman, 'pick', uncapped));
    expect(w.map((x) => x.message)).toEqual([expect.stringMatching(/^loop pick has no bound/)]);
  });

  it('flags an uncapped cycle beside a capped one in the same component', () => {
    const p: Pattern = {
      name: 'two-loops',
      description: 'x',
      requiredContext: [],
      state: [
        { name: 'n', type: 'number' },
        { name: 'maxN', type: 'number', initial: 3 },
      ],
      start: 's',
      nodes: [
        { id: 's', kind: 'start', label: 's' },
        { id: 'hub', kind: 'condition', label: 'hub', expression: 'n < maxN' },
        { id: 'count', kind: 'compute', label: 'count', assign: [{ field: 'n', expr: 'n + 1' }] },
        { id: 'spin', kind: 'compute', label: 'spin', assign: [{ field: 'n', expr: 'n' }] },
        { id: 'other', kind: 'condition', label: 'other', expression: 'n == 0' },
        { id: 'e', kind: 'end', label: 'e', outcome: 'success' },
      ],
      edges: [
        { id: '1', from: 's', to: 'hub' },
        { id: '2', from: 'hub', to: 'count', branch: 'then' },
        { id: '3', from: 'hub', to: 'other', branch: 'else' },
        { id: '4', from: 'count', to: 'hub' },
        // A second way round that avoids the guarded counter.
        { id: '5', from: 'other', to: 'spin', branch: 'then' },
        { id: '6', from: 'other', to: 'e', branch: 'else' },
        { id: '7', from: 'spin', to: 'other' },
      ],
    };
    expect(unboundedLoops(p)).toEqual([['other', 'spin']]);
  });

  it('a cap bounds only the branch it guards: a cycle through the other branch is flagged', () => {
    const p: Pattern = {
      name: 'gate',
      description: 'x',
      requiredContext: [],
      state: [
        { name: 'n', type: 'number' },
        { name: 'maxN', type: 'number', initial: 3 },
      ],
      start: 's',
      nodes: [
        { id: 's', kind: 'start', label: 's' },
        { id: 'top', kind: 'compute', label: 'top', assign: [{ field: 'n', expr: 'n' }] },
        { id: 'gate', kind: 'condition', label: 'gate', expression: 'n < maxN' },
        { id: 'count', kind: 'compute', label: 'count', assign: [{ field: 'n', expr: 'n + 1' }] },
        { id: 'loop', kind: 'condition', label: 'loop', expression: 'n == 0' },
        { id: 'e', kind: 'end', label: 'e', outcome: 'success' },
      ],
      edges: [
        { id: '1', from: 's', to: 'top' },
        { id: '2', from: 'top', to: 'gate' },
        { id: '3', from: 'gate', to: 'count', branch: 'then' },
        { id: '4', from: 'count', to: 'top' },
        // Past the cap, the else branch still goes round, and nothing counts it.
        { id: '5', from: 'gate', to: 'loop', branch: 'else' },
        { id: '6', from: 'loop', to: 'top', branch: 'then' },
        { id: '7', from: 'loop', to: 'e', branch: 'else' },
      ],
    };
    expect(unboundedLoops(p)).toEqual([['top', 'gate', 'loop']]);
    // "n >= maxN" bounds the else branch instead.
    const flipped: Pattern = {
      ...p,
      nodes: p.nodes.map((n) =>
        n.id === 'gate' ? Object.assign({}, n, { expression: 'maxN <= n' }) : n,
      ),
      edges: p.edges.map((x) =>
        x.from === 'gate'
          ? Object.assign({}, x, { branch: x.branch === 'then' ? 'else' : 'then' })
          : x,
      ),
    };
    expect(unboundedLoops(flipped)).toEqual([['top', 'gate', 'loop']]);
  });

  it("investigate's reading waves are bounded by their check caps, its gap loop by its counter", () => {
    expect(loopWarnings(investigate)).toEqual([]);
    // Without the citation check's cap, the triage wave loop has no bound.
    const noCap = editNode(investigate, 'checkTriage', uncapped);
    expect(loopWarnings(noCap).map((w) => w.message)).toEqual([
      expect.stringMatching(/^loop .*takeBatch.*triage.*has no bound/),
    ]);
    // The gap loop is bounded twice: its check's cap, and its counters. Without the cap it
    // still passes; without the counters' increments too, it does not.
    const noChaseCap = editNode(investigate, 'checkChase', uncapped);
    expect(loopWarnings(noChaseCap)).toEqual([]);
    const noCount = editNode(noChaseCap, 'mergeChase', (n) =>
      n.kind === 'compute'
        ? {
            ...n,
            assign: n.assign.filter((a) => a.field !== 'gapRounds' && a.field !== 'chaseRounds'),
          }
        : n,
    );
    expect(
      loopWarnings(noCount)
        .map((w) => w.message)
        .join(),
    ).toMatch(/assess.*chase|chase.*assess/);
  });
});
