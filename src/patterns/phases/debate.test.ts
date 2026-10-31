import { describe, expect, it } from 'vitest';
import { compileScore } from '../../core/compile.js';
import { runScripted } from '../../core/scripted.js';
import type { Complexity, DemoScript, EngineEvent } from '../../core/types.js';
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

const hypothesesRejected = (r: ReturnType<typeof play>['r']) =>
  r.state.events.some((e) => e.type === 'response-rejected' && e.nodeId === 'hypothesize');

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
    // It ends, and says so: an answer with objections still open is partial.
    expect(r.state.outcome).toBe('partial');
    expect(r.state.cursor).toBe('doubts');
    expect(state.debateRounds).toBe(state.maxDebateRounds);
    expect(ran('challenge')).toBe((state.maxDebateRounds as number) + 1);
  });

  it('a routine problem needs 2 hypotheses, a harder one 3', () => {
    const two = (rated: number): DemoScript => ({
      ...demo,
      agents: {
        ...agents,
        hypothesize: (s, v) => ({
          ...agents.hypothesize!(s, v),
          updates: {
            hypotheses: [
              'H1: a | confirm if x | refute if y',
              'H2: none of these | confirm if z | refute if w',
            ],
            ratedComplexity: rated,
          },
        }),
      },
    });
    expect(hypothesesRejected(play(1, two(1)).r)).toBe(false);
    expect(hypothesesRejected(play(2, two(2)).r)).toBe(true);
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
            ? {
                ...agents.hypothesize!(s, v),
                updates: { hypotheses: ['H1: only one'], ratedComplexity: 2 },
              }
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

/** The tier each AI step was played at. */
const tiers = (st: { events: readonly EngineEvent[] }) =>
  Object.fromEntries(
    st.events.flatMap((e) =>
      e.type === 'paused' && e.pause.kind === 'agent' ? [[e.pause.nodeId, e.pause.complexity]] : [],
    ),
  );

describe('complexity: rated from the problem, scaled per step', () => {
  const rate = (rated: number): DemoScript => ({
    ...demo,
    agents: {
      ...agents,
      hypothesize: (s, v) => ({
        ...agents.hypothesize!(s, v),
        updates: { ...agents.hypothesize!(s, v).updates, ratedComplexity: rated },
      }),
    },
  });
  const auto = (script: DemoScript, complexity?: Complexity) =>
    runScripted(
      compileScore(investigate, {
        context: demo.context!,
        ...(complexity ? { complexity } : {}),
        generatedAt: 't',
      }),
      script,
      { at: 't' },
    ).state;

  it('auto: a harder question raises the complexity, and with it the debate', () => {
    const easy = auto(rate(1));
    const hard = auto(rate(4));
    expect(easy.state.complexity).toBe(1);
    expect(hard.state.complexity).toBe(4);
    expect(easy.steps.some((s) => s.nodeId === 'challenge')).toBe(false);
    expect(hard.steps.some((s) => s.nodeId === 'second')).toBe(true);
  });

  it('a chosen complexity always wins over the rating', () => {
    expect(auto(rate(4), 1).state.complexity).toBe(1);
  });

  it('each step plays a tier above or below the run: triage cheaper, the answer smarter', () => {
    const t = tiers(auto(rate(3)));
    expect(t.hypothesize).toBe(3);
    expect(t.triage).toBe(2);
    expect(t.deepRead).toBe(3);
    expect(t.answer).toBe(4);
    expect(t.challenge).toBe(4);
    const low = tiers(auto(rate(1)));
    expect(low.triage).toBe(1);
    expect(low.answer).toBe(2);
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
        ...h.edges,
        { id: 'b', from: h.exit!, to: 'research' },
        { id: 'c', from: 'research', to: c.entry },
        ...c.edges,
      ],
    });
    expect(report.errors).toEqual([]);
  });
});
