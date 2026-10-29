import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript, Pattern } from '../core/types.js';
import { TIER_NAMES } from '../core/catalog.js';
import { analyze, composedScore, fix, maestro, maestroThen } from './index.js';

const demo = maestro.demo!;
const nodesRun = (r: ReturnType<typeof runScripted>) => r.state.steps.map((s) => s.nodeId);

function run(
  request: string,
  agents: Partial<NonNullable<DemoScript['agents']>> = {},
  extra: Partial<DemoScript> = {},
) {
  const script: DemoScript = {
    ...demo,
    ...extra,
    agents: { ...demo.agents, ...agents } as NonNullable<DemoScript['agents']>,
  };
  const score = compileScore(maestro, { goal: 'compose', context: { request }, generatedAt: 't' });
  return { score, r: runScripted(score, script, { at: 't' }) };
}

/** A conductor that fixes what the validator named: guidance only for steps the pattern has. */
const fixingRevise = (s: Readonly<Record<string, unknown>>) => {
  const steps = new Set(((s.outline as string[]) ?? []).map((l) => l.split(' ')[0]));
  const a = (s.adaptation ?? {}) as { directives?: Record<string, string> };
  const directives = Object.fromEntries(
    Object.entries(a.directives ?? {}).filter(
      ([id]) => !(s.draftErrors as string[])?.length || steps.has(id),
    ),
  );
  return {
    updates: { draft: s.draft, adaptation: { ...a, directives }, debateNotes: [] },
    verdict: { outcome: 'applied' as const, confidence: 1, shouldTerminate: false, reason: 'r' },
  };
};

const classifyAs =
  (chosen: string, complexity: number, thenPattern = '') =>
  () => ({
    updates: { chosen, complexity, classifyReason: 'test', thenPattern, requirements: ['fix it'] },
    verdict: { outcome: 'applied' as const, confidence: 1, shouldTerminate: false, reason: 'r' },
  });

describe('maestro', () => {
  it('may chain a second pattern after the composed score, never the same one or itself', () => {
    // The demo library holds fix and analyze.
    const { r } = run('Find out why signups dropped, then fix it', {
      classify: classifyAs('analyze', 1, 'fix'),
    });
    expect(r.state.outcome).toBe('success');
    expect(maestroThen(r.state.state)).toEqual(['fix']);
    let n = 0;
    const bad = run('fix it', {
      classify: () => {
        const answers = [
          classifyAs('fix', 1, 'fix')(),
          classifyAs('fix', 1, 'maestro')(),
          classifyAs('fix', 1)(),
        ];
        return answers[n++]!;
      },
    });
    const rejected = bad.r.state.events.flatMap((e) =>
      e.type === 'response-rejected' ? [e.errors.join()] : [],
    );
    expect(rejected.filter((e) => /thenPattern must be/.test(e))).toHaveLength(2);
    expect(maestroThen(bad.r.state.state)).toEqual([]);
  });

  it('tier 3 debates with proposer, skeptic and pragmatist, then composes the fix score', () => {
    const { score, r } = run('Fix the flaky login test that fails on CI');
    expect(r.state.outcome).toBe('success');
    const ran = nodesRun(r);
    expect(ran).toEqual(
      expect.arrayContaining([
        'classify',
        'propose',
        'skeptic',
        'pragmatist',
        'revise',
        'validate',
        'context',
        'gate',
      ]),
    );
    expect(ran).not.toContain('critic');
    expect(r.state.state.chosen).toBe('fix');
    const composed = composedScore(score, r.state.state, { generatedAt: 't' })!;
    expect(composed.pattern.name).toBe('fix');
    expect(composed.score).toMatchObject({
      complexity: 3,
      goal: 'Fix the flaky login test that fails on CI',
      context: { issue: 'Fix the flaky login test that fails on CI' },
    });
  });

  it('tier 1 with a fitting pattern skips the debate entirely', () => {
    const { r } = run('fix the typo', { classify: classifyAs('fix', 1) });
    expect(nodesRun(r)).not.toContain('propose');
    expect(r.state.state.finalPattern).toMatchObject({ name: 'fix' });
  });

  it('tier 2 runs proposer and skeptic, and the conductor folds in the critique', () => {
    const { r } = run('fix it', { classify: classifyAs('fix', 2) });
    const ran = nodesRun(r);
    expect(ran).toEqual(expect.arrayContaining(['propose', 'skeptic', 'revise']));
    expect(ran).not.toContain('pragmatist');
  });

  it('tier 4 adds the template-critic, who can reroute once', () => {
    let critiques = 0;
    const { r } = run('fix the dashboard numbers', {
      classify: classifyAs('fix', 4),
      critic: () => ({
        updates:
          critiques++ === 0
            ? {
                fit: 'WRONG',
                criticReason: "'numbers' signals analysis, not a bug",
                recommended: 'analyze',
              }
            : { fit: 'CORRECT', criticReason: 'fits', recommended: '' },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      }),
    });
    expect(nodesRun(r).filter((n) => n === 'critic')).toHaveLength(2);
    expect(nodesRun(r)).toContain('switch');
    expect(r.state.state).toMatchObject({ chosen: 'analyze', rerouted: true });
    expect(r.state.state.finalPattern).toMatchObject({ name: 'analyze' });
  });

  it('sends validation errors to the conductor, not the whole debate, and gives up after maxRounds', () => {
    const v = { outcome: 'applied' as const, confidence: 1, shouldTerminate: false, reason: 'r' };
    const { r } = run('do something new', {
      classify: classifyAs('new', 2),
      propose: () => ({
        updates: { draft: { name: 'broken' }, adaptation: {}, assumptions: ['a'] },
        verdict: v,
      }),
      // The conductor fixes what the validator named.
      revise: (s) => ({
        updates: {
          draft: (s.draftErrors as string[]).length
            ? (demo.agents!.propose!({ ...s, chosen: 'new' }, 0).updates.draft as object)
            : s.draft,
          adaptation: {},
          debateNotes: [],
        },
        verdict: v,
      }),
    });
    expect(nodesRun(r).filter((n) => n === 'propose')).toHaveLength(1);
    expect(nodesRun(r).filter((n) => n === 'skeptic')).toHaveLength(1);
    expect(nodesRun(r).filter((n) => n === 'revise')).toHaveLength(2);
    expect(r.state.state.round).toBe(2);
    expect(r.state.outcome).toBe('success');

    const never = run('do something new', {
      classify: classifyAs('new', 2),
      propose: () => ({
        updates: { draft: { name: 'broken' }, adaptation: {}, assumptions: ['a'] },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      }),
    });
    expect(never.r.state.cursor).toBe('gaveUp');
    expect(never.r.state.outcome).toBe('failed');
  });

  const feedbackOnce = (smarter: boolean) => {
    let gates = 0;
    return run(
      'fix it',
      { classify: classifyAs('fix', 2) },
      {
        approvals: {
          gate: () => ({
            approved: true,
            updates: { feedback: gates++ === 0 ? 'also add a regression test' : '', smarter },
          }),
        },
      },
    ).r;
  };

  it('go-gate feedback with smarter escalates complexity and runs another round', () => {
    const r = feedbackOnce(true);
    expect(nodesRun(r).filter((n) => n === 'propose')).toHaveLength(2);
    expect(r.state.state).toMatchObject({ complexity: 3, round: 2 });
    expect(nodesRun(r)).toContain('pragmatist');
  });

  it('go-gate feedback alone runs another round at the same tier', () => {
    const r = feedbackOnce(false);
    expect(nodesRun(r).filter((n) => n === 'propose')).toHaveLength(2);
    expect(r.state.state).toMatchObject({ complexity: 2, round: 2 });
    // The same tier keeps the same (smaller) debate: no pragmatist at complexity 2.
    expect(nodesRun(r)).not.toContain('pragmatist');
    expect(r.state.outcome).toBe('success');
  });
});

describe('analyze (classical vs jazz)', () => {
  const context = analyze.demo!.context!;
  it('classical plays the written melody: every budgeted analysis, then conclude', () => {
    const score = compileScore(analyze, { goal: 'g', context, improvisation: 0 });
    const r = runScripted(score, analyze.demo);
    expect(r.state.state.analyses).toHaveLength(4);
    expect(
      r.state.steps.filter((s) => s.nodeId === 'muse').every((s) => s.next === undefined),
    ).toBe(true);
  });

  it('swing lets the muse solo and conclude early', () => {
    const score = compileScore(analyze, { goal: 'g', context });
    expect(score.improvisation).toBe(2);
    const r = runScripted(score, analyze.demo);
    expect(r.state.state.analyses).toHaveLength(2);
    expect(r.state.steps.filter((s) => s.nodeId === 'muse').map((s) => s.next)).toEqual([
      'dig',
      'dig',
      'wrap',
    ]);
    expect(r.state.outcome).toBe('success');
  });
});

describe('composedScore', () => {
  it('ignores runs that are not maestro or have no valid final pattern', () => {
    const s = compileScore(analyze, { goal: 'g', context: analyze.demo!.context! });
    expect(composedScore(s, {})).toBeUndefined();
    const m = compileScore(maestro, { goal: 'g', context: { request: 'x' } });
    expect(composedScore(m, { finalPattern: {} })).toBeUndefined();
    const p = (({ demo: _d, ...rest }) => rest)(analyze) as Pattern;
    const state = {
      finalPattern: p,
      complexity: 4,
      request: 'r',
      childContext: { question: 'q', data: '', bogus: 1 },
    };
    expect(() => composedScore(m, state)).toThrow(/missing required context 'data'/);
    const ok = composedScore(m, { ...state, childContext: { question: 'q', data: 'sales.csv' } });
    expect(ok?.score).toMatchObject({
      complexity: 4,
      improvisation: 0,
      context: { question: 'q', data: 'sales.csv' },
    });
  });
});

describe('maestro adapts library patterns instead of rewriting them', () => {
  const v = { outcome: 'applied' as const, confidence: 1, shouldTerminate: false, reason: 'r' };
  const proposing =
    (...answers: Record<string, unknown>[]) =>
    (_s: Readonly<Record<string, unknown>>, visit: number) => ({
      updates: {
        draft: {},
        adaptation: {},
        assumptions: ['a'],
        ...answers[Math.min(visit, answers.length - 1)],
      },
      verdict: v,
    });

  it('the composed score is the tested pattern: same steps and edges, guidance and settings applied', () => {
    const { r } = run('Fix the flaky login test that fails on CI about once in ten runs');
    expect(r.state.outcome).toBe('success');
    const final = r.state.state.finalPattern as Pattern;
    expect(final.name).toBe('fix');
    expect(final.nodes.map((n) => n.id)).toEqual(fix.nodes.map((n) => n.id));
    expect(final.edges).toEqual(fix.edges);
    const hypothesize = final.nodes.find((n) => n.id === 'hypothesize') as { directive: string };
    expect(hypothesize.directive).toMatch(/For this request: It fails about once in ten CI runs/);
    expect(final.state.find((f) => f.name === 'maxAttempts')!.initial).toBe(2);
  });

  it('the proposer reads an outline, a fraction of the template', () => {
    const { r } = run('Fix the flaky login test that fails on CI about once in ten runs');
    const input = r.state.steps.find((st) => st.nodeId === 'propose')!.input!;
    expect(input).not.toHaveProperty('template');
    expect((input.outline as string[]).length).toBe(fix.nodes.length);
    expect(JSON.stringify(input).length).toBeLessThan(
      JSON.stringify(r.state.state.template).length / 2,
    );
  });

  it('an adaptation that does not fit goes to the conductor with the errors, not a new debate', () => {
    const { r } = run('fix it', {
      classify: classifyAs('fix', 2),
      propose: proposing({
        adaptation: {
          directives: { diagnoseEverything: 'x', hypothesize: 'Look at the session cookie first.' },
        },
      }),
      revise: fixingRevise,
    });
    expect(nodesRun(r).filter((n) => n === 'propose')).toHaveLength(1);
    const second = r.state.steps.filter((st) => st.nodeId === 'revise')[1]!.input!;
    expect(String(second.draftErrors)).toMatch(/no step 'diagnoseEverything' in fix/);
    expect(r.state.outcome).toBe('success');
    expect(r.state.state.adaptation).toEqual({
      directives: { hypothesize: 'Look at the session cookie first.' },
    });
  });

  it('a full rewrite is still possible when the shape must change', () => {
    const { r } = run('fix it', {
      classify: classifyAs('fix', 2),
      propose: proposing({
        draft: { ...analyze, demo: undefined, name: 'fix-reshaped' },
        assumptions: ['needs a profile first'],
      }),
      revise: (s) => ({
        updates: { draft: s.draft, adaptation: s.adaptation, debateNotes: [] },
        verdict: v,
      }),
    });
    expect((r.state.state.finalPattern as Pattern).name).toBe('fix-reshaped');
  });

  it('skips the pragmatist and the conductor when the skeptic finds nothing to change', () => {
    const quiet = () => ({ updates: { failureModes: [], contested: [], edits: [] }, verdict: v });
    const { r } = run('fix it', { classify: classifyAs('fix', 3), skeptic: quiet });
    expect(r.state.outcome).toBe('success');
    expect(nodesRun(r)).not.toContain('pragmatist');
    expect(nodesRun(r)).not.toContain('revise');
    expect(
      (r.state.state.finalPattern as Pattern).nodes.find((n) => n.id === 'hypothesize'),
    ).toMatchObject({
      directive: expect.stringMatching(/For this request:/),
    });
    // Tier 4 still asks the template-critic about the fit.
    const four = run('fix it', { classify: classifyAs('fix', 4), skeptic: quiet });
    expect(nodesRun(four.r)).toContain('critic');
  });
});

describe('maestro remembers approved compositions', () => {
  const adaptation = { directives: { hypothesize: 'Timing races between tests first.' } };
  const remembered = (over: Record<string, unknown> = {}) => ({
    recall: () => ({
      exact: {
        request: 'r',
        chosen: 'fix',
        complexity: 3,
        thenPattern: '',
        adaptation,
        pattern: {},
        template: 'x',
        at: 't',
        ...over,
      },
      similar: [],
    }),
  });

  it('the same request again: no classification, no debate, the approved adaptation is reused', () => {
    const { r } = run(
      'Fix the flaky login test',
      {},
      { tools: { ...demo.tools, ...remembered() } },
    );
    expect(r.state.outcome).toBe('success');
    const ran = nodesRun(r);
    for (const id of ['classify', 'propose', 'skeptic', 'revise']) expect(ran).not.toContain(id);
    expect(ran).toEqual(
      expect.arrayContaining(['reuse', 'validate', 'context', 'gate', 'remember']),
    );
    const final = r.state.state.finalPattern as Pattern;
    expect(final.nodes.find((n) => n.id === 'hypothesize')).toMatchObject({
      directive: expect.stringMatching(/For this request: Timing races between tests first\.$/),
    });
    expect(r.state.state).toMatchObject({ reused: true, complexity: 3, chosen: 'fix' });
    expect(String(r.state.state.debateNotes)).toMatch(/approved before, so there was no debate/);
  });

  it('similar requests are precedent for the classifier and the proposer', () => {
    const similar = [
      '2026-01-01 | "Fix the flaky signup test" → fix (complexity 3); adaptation {}',
    ];
    const { r } = run(
      'Fix the flaky login test',
      {},
      {
        tools: { ...demo.tools, recall: () => ({ exact: {}, similar }) },
      },
    );
    for (const id of ['classify', 'propose'])
      expect(r.state.steps.find((st) => st.nodeId === id)!.input!.pastCompositions).toEqual(
        similar,
      );
  });

  it('a remembered adaptation that no longer fits goes to the conductor with the errors', () => {
    const { r } = run(
      'Fix the flaky login test',
      { revise: fixingRevise },
      {
        tools: { ...demo.tools, ...remembered({ adaptation: { directives: { gone: 'x' } } }) },
      },
    );
    const revise = r.state.steps.find((st) => st.nodeId === 'revise')!;
    expect(String(revise.input!.draftErrors)).toMatch(/no step 'gone'/);
    expect(nodesRun(r)).not.toContain('propose');
    expect(r.state.outcome).toBe('success');
  });

  it('feedback on a reused composition composes it afresh', () => {
    const { r } = run(
      'Fix the flaky login test',
      {},
      {
        tools: { ...demo.tools, ...remembered() },
        approvals: {
          gate: (_s, visit) => ({
            approved: true,
            updates: { feedback: visit === 0 ? 'also check the retry logic' : '', smarter: false },
          }),
        },
      },
    );
    expect(nodesRun(r)).toContain('propose');
    expect(r.state.state.reused).toBe(false);
    expect(r.state.outcome).toBe('success');
  });
});

/** A person who asks for another change at every go-gate. */
const asking = (_s: Readonly<Record<string, unknown>>, visit: number) => ({
  approved: true,
  updates: { feedback: `round ${visit + 1}: also check the retry logic`, smarter: true },
});

describe('maestro never drops go-gate feedback', () => {
  it('feedback at the last round ends partial, keeping the draft and the feedback, and performs nothing', () => {
    const { score, r } = run('Fix the flaky login test', {}, { approvals: { gate: asking } });
    expect(r.state.outcome).toBe('partial');
    expect(r.state.cursor).toBe('feedbackUnapplied');
    const s = r.state.state;
    expect(s.round).toBe(s.maxRounds);
    expect(s.unappliedFeedback).toBe(`round ${s.maxRounds}: also check the retry logic`);
    expect(String(s.debateNotes)).toMatch(/Not applied, out of rounds \(maxRounds\): round 6/);
    expect(s.finalPattern).toEqual({});
    expect(s.normalized).toMatchObject({ name: 'fix' });
    expect(nodesRun(r)).not.toContain('remember');
    expect(composedScore(score, s)).toBeUndefined();
    expect(maestro.result).toEqual(['unappliedFeedback']);
  });

  it('empty feedback at the last round still performs', () => {
    const { r } = run(
      'Fix the flaky login test',
      {},
      {
        approvals: {
          gate: (s) => ({
            approved: true,
            updates: { feedback: s.round === s.maxRounds ? '' : 'more', smarter: false },
          }),
        },
      },
    );
    expect(r.state.outcome).toBe('success');
    expect(r.state.state.unappliedFeedback).toBe('');
  });
});

describe('maestro keeps a preset complexity', () => {
  const at = (complexity: 1 | 2 | 3 | 4, extra: Partial<DemoScript> = {}) => {
    const score = compileScore(maestro, {
      goal: 'compose',
      context: { request: 'Fix the flaky login test' },
      complexity,
      generatedAt: 't',
    });
    return runScripted(score, { ...demo, ...extra }, { at: 't' });
  };

  it('a preset of 2 stays 2: the classifier rates 3, its rating is kept for the record', () => {
    const r = at(2);
    expect(r.state.outcome).toBe('success');
    expect(r.state.state).toMatchObject({ complexity: 2, presetComplexity: 2, ratedComplexity: 3 });
    expect(nodesRun(r)).toContain('skeptic');
    expect(nodesRun(r)).not.toContain('pragmatist');
  });

  it('without a preset the classifier decides; a preset also wins over a remembered composition', () => {
    const auto = run('Fix the flaky login test').r;
    expect(auto.state.state).toMatchObject({
      complexity: 3,
      presetComplexity: 0,
      ratedComplexity: 3,
    });
    const remembered = at(1, {
      tools: {
        ...demo.tools,
        recall: () => ({
          exact: {
            request: 'r',
            chosen: 'fix',
            complexity: 4,
            thenPattern: '',
            adaptation: {},
            pattern: {},
            template: 'x',
            at: 't',
          },
          similar: [],
        }),
      },
    });
    expect(remembered.state.state.complexity).toBe(1);
  });
});

/** A runnable score whose AI steps are `ids`, in order. */
const scoreOf = (ids: string[]) => ({
  name: 'double-helix',
  description: 'Model the abstract and the concrete as the two strands of a double helix.',
  verbTriggers: [],
  requiredContext: ['subject'],
  goalFrom: 'subject',
  state: [{ name: 'subject', type: 'string' }, ...ids.map((id) => ({ name: id, type: 'string' }))],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    ...ids.map((id) => ({
      id,
      kind: 'agent',
      role: 'assessor',
      label: id,
      directive: id,
      reads: ['subject'],
      writes: [id],
    })),
    { id: 'done', kind: 'end', label: 'Done', outcome: 'success' },
  ],
  edges: ['start', ...ids, 'done']
    .slice(1)
    .map((to, i, all) => ({ id: `e${i}`, from: i === 0 ? 'start' : all[i - 1]!, to })),
});
const FIRST = ['clarify', 'ground', 'map', 'verify'];
const ASKED = 'Add an extra step of a proposed algorithm that can be implemented in symphony';

/** A judge that checks substance: the step a requirement asks for must be there. */
const strictCover = (s: Readonly<Record<string, unknown>>) => {
  const ids = ((s.draft as { nodes?: { id: string }[] }).nodes ?? []).map((n) => n.id);
  const coverage = (s.requirements as string[]).map((r, i) => {
    const missing = /algorithm/i.test(r)
      ? !ids.some((id) => /algorithm/i.test(id))
      : /keep the removed steps/i.test(r)
        ? !FIRST.every((id) => ids.includes(id))
        : ids.length === 0;
    return missing ? `R${i + 1}: NOT COVERED — ${r}` : `R${i + 1}: ${ids[0]} — met`;
  });
  return {
    updates: { coverage, uncovered: coverage.filter((c) => c.includes('NOT COVERED')) },
    verdict: { outcome: 'applied' as const, confidence: 1, shouldTerminate: false, reason: 'r' },
  };
};

describe('maestro keeps a requirement ledger (replaying run 05-02-16)', () => {
  const v = { outcome: 'applied' as const, confidence: 1, shouldTerminate: false, reason: 'r' };
  const feedbacks = [ASKED, 'I want to keep the removed steps', ''];
  let reviseVisits = 0;
  const replay = () =>
    run(
      'I have a vision of the double helix model as a model of the abstract and the concrete',
      {
        classify: () => ({
          updates: {
            chosen: 'new',
            complexity: 2,
            classifyReason: 'novel',
            thenPattern: '',
            requirements: [
              'Model the abstract and the concrete as the two strands of a double helix',
            ],
          },
          verdict: v,
        }),
        // The proposer adds what feedback asks for...
        propose: (s) => ({
          updates: {
            draft: scoreOf(
              (s.requirements as string[]).length > 1
                ? [...FIRST.slice(0, 3), 'algorithmize', 'verify']
                : FIRST,
            ),
            adaptation: {},
            assumptions: ['a'],
          },
          verdict: v,
        }),
        // ...and, as recorded, the conductor right after the feedback drops steps.
        revise: (s) => {
          reviseVisits += 1;
          const ids = ((s.draft as { nodes: { id: string; kind: string }[] }).nodes ?? [])
            .filter((n) => n.kind === 'agent')
            .map((n) => n.id);
          return {
            updates: {
              draft: scoreOf(reviseVisits === 2 ? ['clarify', 'ground', 'verify'] : ids),
              adaptation: {},
              debateNotes: [],
            },
            verdict: v,
          };
        },
        cover: strictCover,
      },
      {
        approvals: {
          gate: (_s, visit) => ({
            approved: true,
            updates: { feedback: feedbacks[visit] ?? '', smarter: true },
          }),
        },
      },
    );

  it('every feedback joins the ledger; a dropped step is caught and sent back, so the score keeps it', () => {
    reviseVisits = 0;
    const { r } = replay();
    expect(r.state.outcome).toBe('success');
    const s = r.state.state;
    expect(s.requirements).toEqual([
      'Model the abstract and the concrete as the two strands of a double helix',
      `From your feedback: ${ASKED}`,
      'From your feedback: I want to keep the removed steps',
    ]);
    // The conductor's drop was caught and sent back with what was missing.
    expect(nodesRun(r)).toContain('requeue');
    const resent = r.state.steps.find(
      (st) => st.nodeId === 'propose' && String(st.input?.draftErrors).includes('NOT COVERED'),
    );
    expect(String(resent?.input?.draftErrors)).toMatch(/proposed algorithm/);
    const final = (s.finalPattern as Pattern).nodes.map((n) => n.id);
    expect(final).toEqual(
      expect.arrayContaining(['algorithmize', ...FIRST.filter((id) => id !== 'map')]),
    );
    expect(s.uncovered).toEqual([]);
    expect(s.coverage).toHaveLength(3);
    // The go-gate showed how each requirement is met.
    expect(maestro.nodes.find((n) => n.id === 'gate')).toMatchObject({
      shows: ['coverage', 'uncovered'],
    });
  });

  it('out of rounds, an uncovered requirement is shown at the go-gate instead of silently dropped', () => {
    const { r } = run('fix it', {
      classify: classifyAs('fix', 2),
      cover: (s) => ({
        ...strictCover(s),
        updates: { coverage: ['R1: NOT COVERED — x'], uncovered: ['R1: NOT COVERED — x'] },
      }),
    });
    // Re-proposed until the rounds ran out, then the go-gate (which shows `uncovered`) was asked.
    expect(r.state.state.round).toBe(r.state.state.maxRounds);
    expect(nodesRun(r).filter((id) => id === 'requeue')).toHaveLength(
      Number(r.state.state.maxRounds) - 1,
    );
    expect(nodesRun(r)).toContain('gate');
    expect(r.state.state.uncovered).toEqual(['R1: NOT COVERED — x']);
  });
});

describe('maestro shares its names with the other surfaces', () => {
  it("the classifier's tiers are the shared tier names", () => {
    const classify = maestro.nodes.find((n) => n.id === 'classify') as { directive: string };
    for (const [tier, name] of Object.entries(TIER_NAMES))
      expect(classify.directive).toMatch(new RegExp(`${tier} [^;]*\\b${name}\\b`));
  });
});

describe('maestro fixes structural errors in the conductor (replaying 05-02-16)', () => {
  it('an empty draft and a broken expression cost a conductor call each, not a new debate', () => {
    const v = { outcome: 'applied' as const, confidence: 1, shouldTerminate: false, reason: 'r' };
    const good = scoreOf(FIRST);
    const brokenCheck = {
      ...good,
      nodes: good.nodes.map((n) =>
        n.id === 'clarify'
          ? { ...n, checks: [{ expr: "(includes(lower(subject),'2d')", message: 'x' }] }
          : n,
      ),
    };
    // As recorded: after the feedback, the conductor's draft was empty, then had a bad check.
    const drafts = [good, {}, brokenCheck, good];
    let revisions = 0;
    const { r } = run(
      'I have a vision of the double helix model',
      {
        classify: () => ({
          updates: {
            chosen: 'new',
            complexity: 4,
            classifyReason: 'novel',
            thenPattern: '',
            requirements: ['model it'],
          },
          verdict: v,
        }),
        propose: () => ({
          updates: { draft: good, adaptation: {}, assumptions: ['a'] },
          verdict: v,
        }),
        revise: () => ({
          updates: { draft: drafts[revisions++] ?? good, adaptation: {}, debateNotes: [] },
          verdict: v,
        }),
      },
      {
        approvals: {
          gate: (_s, visit) => ({
            approved: true,
            updates: { feedback: visit === 0 ? ASKED : '', smarter: true },
          }),
        },
      },
    );
    expect(r.state.outcome).toBe('success');
    const count = (id: string) => nodesRun(r).filter((n) => n === id).length;
    // Two debates (the first round and the feedback round); the errors never restart one.
    expect(count('propose')).toBe(2);
    expect(count('skeptic')).toBe(2);
    // The empty draft is caught by the conductor's own check and re-asked in the same step;
    // the broken check is caught by validation and costs one more conductor call.
    const revises = r.state.steps.filter((st) => st.nodeId === 'revise');
    expect(revises).toHaveLength(3);
    expect(JSON.stringify(revises[1]!.attempts)).toMatch(/put the final pattern object in draft/);
    expect(String(revises[2]!.input?.draftErrors)).toMatch(/is invalid/);
  });
});
