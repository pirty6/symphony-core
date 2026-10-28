import { describe, expect, it } from 'vitest';
import { compileScore } from '../../core/compile.js';
import { runScripted } from '../../core/scripted.js';
import type { Complexity, DemoScript } from '../../core/types.js';
import { validatePattern } from '../../core/validate.js';
import { investigate } from '../index.js';
import { challengePhase, hypothesesPhase, withState } from './debate.js';

const demo = investigate.demo!;
const agents = demo.agents!;

function play(complexity: Complexity, script: DemoScript = demo) {
  const score = compileScore(investigate, { context: demo.context!, complexity, generatedAt: 't' });
  const r = runScripted(score, script, { at: 't' });
  const ran = (id: string) => r.state.steps.filter((s) => s.nodeId === id).length;
  return { r, ran, state: r.state.state };
}

describe('debate phases in investigate', () => {
  it('complexity 1: hypotheses only, no debate', () => {
    const { r, ran } = play(1);
    expect(r.state.outcome).toBe('success');
    expect(ran('hypothesize')).toBe(1);
    expect(ran('challenge')).toBe(0);
  });

  it('complexity 2: the skeptic, every objection researched', () => {
    const { ran, state } = play(2);
    expect(ran('challenge')).toBe(2);
    expect(ran('triageObjections')).toBe(0);
    expect(state.debateRounds).toBe(1);
  });

  it('complexity 3: a pragmatist keeps only real objections', () => {
    const theoretical: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        triageObjections: (s) => ({
          ...agents.triageObjections!(s, 0),
          updates: {
            objectionTriage: (s.objections as string[]).map((o) => `${o}: THEORETICAL — x`),
            realObjections: [],
          },
        }),
      },
    };
    const { ran, state } = play(3, theoretical);
    expect(ran('triageObjections')).toBe(1);
    expect(ran('chase')).toBe(1);
    expect(state.debateRounds).toBe(0);
  });

  it('complexity 4: an independent second investigator, reconciled', () => {
    const { r, ran } = play(4);
    expect(ran('second')).toBe(1);
    expect(ran('reconcile')).toBe(1);
    const second = r.state.steps.find((s) => s.nodeId === 'second')!;
    // Independent: it never saw the first answer or its evidence.
    expect(Object.keys(second.input ?? {})).not.toContain('answer');
    expect(Object.keys(second.input ?? {})).not.toContain('findings');
  });

  it('a skeptic that never stops objecting is cut off after maxDebateRounds', () => {
    const relentless: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        challenge: (s, v) => ({
          ...agents.challenge!(s, v),
          updates: { objections: [`objection ${v}`] },
        }),
      },
    };
    const { r, ran, state } = play(2, relentless);
    expect(r.state.outcome).toBe('success');
    expect(state.debateRounds).toBe(state.maxDebateRounds);
    expect(ran('challenge')).toBe((state.maxDebateRounds as number) + 1);
  });

  it('rejects hypotheses that are too few and an answer that skips a ruling', () => {
    let first = true;
    let proposals = 0;
    const sloppy: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        hypothesize: (s, v) =>
          proposals++ === 0
            ? { ...agents.hypothesize!(s, v), updates: { hypotheses: ['H1: only one'] } }
            : agents.hypothesize!(s, v),
        answer: (s, v) => {
          const good = agents.answer!(s, v);
          if (!first) return good;
          first = false;
          return { ...good, updates: { ...good.updates, rulings: [] } };
        },
      },
    };
    const { r } = play(2, sloppy);
    expect(r.state.outcome).toBe('success');
    const rejected = r.state.events.flatMap((e) => (e.type === 'response-rejected' ? [e] : []));
    expect(
      rejected.some((e) => e.nodeId === 'hypothesize' && /at least 3/.test(e.errors.join())),
    ).toBe(true);
    expect(
      rejected.some(
        (e) => e.nodeId === 'answer' && /one ruling per hypothesis/.test(e.errors.join()),
      ),
    ).toBe(true);
  });
});

describe('debate fragments', () => {
  it('fit any pattern: state merges without duplicates and the result validates', () => {
    const h = hypothesesPhase({ subject: 'issue', context: [] });
    const c = challengePhase({
      subject: 'issue',
      evidence: 'notes',
      draft: 'diagnosis',
      gaps: 'todo',
      reopen: 'research',
      done: 'end',
      research: [],
    });
    const state = withState(
      [
        { name: 'issue', type: 'string' },
        { name: 'notes', type: 'string[]' },
        { name: 'diagnosis', type: 'string' },
        { name: 'todo', type: 'string[]' },
        { name: 'complexity', type: 'number', initial: 3 },
      ],
      h,
      c,
    );
    expect(state.filter((f) => f.name === 'complexity')).toEqual([
      { name: 'complexity', type: 'number', initial: 3 },
    ]);
    const report = validatePattern({
      name: 'mini',
      description: 'd',
      requiredContext: ['issue'],
      state,
      start: 'start',
      groups: [h.group, c.group],
      nodes: [
        { id: 'start', kind: 'start', label: 'S' },
        ...h.nodes,
        {
          id: 'research',
          kind: 'agent',
          role: 'assessor',
          label: 'Research',
          directive: 'd',
          reads: ['issue', 'todo'],
          writes: ['notes', 'diagnosis'],
        },
        ...c.nodes,
        { id: 'end', kind: 'end', label: 'E' },
      ],
      edges: [
        { id: 'a', from: 'start', to: h.entry },
        { id: 'b', from: h.entry, to: 'research' },
        { id: 'c', from: 'research', to: c.entry },
        ...c.edges,
      ],
    });
    expect(report.errors).toEqual([]);
  });
});
