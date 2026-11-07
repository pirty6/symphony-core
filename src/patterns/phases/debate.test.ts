import { describe, expect, it } from 'vitest';
import { compileScore } from '../../core/compile.js';
import { runScripted } from '../../core/scripted.js';
import type { Complexity, DemoScript, EngineEvent } from '../../core/types.js';
import { validatePattern } from '../../core/validate.js';
import { investigate } from '../index.js';
import { assessFor } from '../investigate.js';
import { challengePhase, hypothesesPhase, withState } from './debate.js';

const demo = investigate.demo!;

/** investigate with each setting as set on its own (lean off): these tests check one mechanism each. */
const compileInvestigate = (opts: Parameters<typeof compileScore>[1] = {}) =>
  compileScore(investigate, { ...opts, context: { lean: false, ...opts.context } });
const agents = demo.agents!;
/** Research that finds something new each round: the debate goes on until its cap. */
const finding: NonNullable<DemoScript['agents']>[string] = (s, v) => ({
  ...agents.chase!(s, v),
  updates: {
    queries: [`git log -S x (round ${v})`],
    gapRuns: [],
    newFindings: [`git-history | commit c${v} — round ${v} found something new`],
  },
});

function play(complexity: Complexity, script: DemoScript = demo) {
  const score = compileInvestigate({ context: demo.context!, complexity, generatedAt: 't' });
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

  it('pragmatistFrom 2 (a trial switch) brings the pragmatist in at complexity 2', () => {
    const score = compileInvestigate({
      context: { ...demo.context!, pragmatistFrom: 2 },
      complexity: 2,
      generatedAt: 't',
    });
    const r = runScripted(score, demo, { at: 't' });
    expect(r.state.steps.filter((x) => x.nodeId === 'triageObjections')).toHaveLength(1);
    expect(r.state.outcome).toBe('success');
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
    // Its evidence is checked and numbered, and the reconciled answer must cite findings.
    expect(ran('checkSecond')).toBe(1);
    expect(r.state.state.findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^F\d+ src\/core\/engine.ts:1 — resolveAgent checks/),
      ]),
    );
    const reconcile = investigate.nodes.find((n) => n.id === 'reconcile') as unknown as {
      checks: { expr: string }[];
    };
    expect(reconcile.checks.map((c) => c.expr)).toContain(
      'len(refs(answer)) > 0 && subset(refs(answer), ids(findings))',
    );
  });

  it('a skeptic that never stops objecting is cut off after maxDebateRounds', () => {
    const relentless: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        chase: finding,
        challenge: (s, v) => ({
          ...agents.challenge!(s, v),
          updates: { objections: [`S1: F1 objection ${v}`] },
        }),
      },
    };
    // The last round's objection is one the rewritten answer could not settle.
    const unsettled: DemoScript = {
      ...relentless,
      agents: {
        ...relentless.agents,
        answer: (s, v) => {
          const base = agents.answer!(s, v) as { updates: Record<string, unknown> };
          const open = ((s.realObjections as string[]) ?? []).map(
            (o) => `${o.split(':')[0]}: OPEN — still nothing that reads x`,
          );
          return { ...base, updates: { ...base.updates, objectionResolutions: open } } as never;
        },
      },
    };
    const { r, ran, state } = play(2, unsettled);
    expect(state.debateRounds).toBe(state.maxDebateRounds);
    // No challenge once no research round is left: it could not reopen anything.
    expect(ran('challenge')).toBe(state.maxDebateRounds);
    // It ends, and says so: what the answer could not settle makes it partial.
    expect(r.state.outcome).toBe('partial');
    expect(r.state.cursor).toBe('doubts');
    expect(state.doubts).toEqual([
      expect.stringMatching(/^Objections the answer could not settle: S1: OPEN/),
    ]);
    // An unsettled answer teaches nothing: no lesson, and no facts remembered.
    expect(ran('learnAnswer')).toBe(0);
    expect(ran('rememberCited')).toBe(0);
  });

  it('after the last round, what the answer settled leaves no doubt', () => {
    const settled: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        chase: finding,
        challenge: (s, v) => ({
          ...agents.challenge!(s, v),
          updates: { objections: [`S1: F1 objection ${v}`] },
        }),
        answer: (s, v) => {
          const base = agents.answer!(s, v) as { updates: Record<string, unknown> };
          const done = ((s.realObjections as string[]) ?? []).map(
            (o) => `${o.split(':')[0]}: RESOLVED — the new commit shows it [F1]`,
          );
          return { ...base, updates: { ...base.updates, objectionResolutions: done } } as never;
        },
      },
    };
    const { r, state } = play(3, settled);
    expect(state.debateRounds).toBe(3);
    expect(state.unresolvedObjections).toEqual([]);
    expect(r.state.outcome).toBe('success');
  });

  it('objections name their sub-question, and stay open through research until it settles them', () => {
    const untagged: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        challenge: (s, v) => ({
          ...agents.challenge!(s, v),
          updates: { objections: v === 0 ? ['no sub-question named'] : [] },
        }),
      },
    };
    const rejected = play(2, untagged).r.state.events.some(
      (e) =>
        e.type === 'response-rejected' && e.nodeId === 'challenge' && /S1: …/.test(e.errors.join()),
    );
    expect(rejected).toBe(true);
    // An objection the research did not settle stays a gap (assess may keep it now).
    let assessed = 0;
    const unsettled: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        assess: (s, v) => {
          const open = (s.openObjections as string[]) ?? [];
          return open.length && assessed++ === 0
            ? {
                ...agents.assess!(s, v),
                updates: { ...assessFor(s, [open[0]!]), confidence: 0.8 },
              }
            : agents.assess!(s, v);
        },
      },
    };
    const { r, state } = play(2, unsettled);
    expect(state.openObjections).toEqual([expect.stringMatching(/^S2: /)]);
    const kept = r.state.steps.filter(
      (st) =>
        st.nodeId === 'assess' &&
        (st.updates?.objectionGaps as string[] | undefined)?.[0]?.startsWith('S2: '),
    );
    expect(kept).toHaveLength(1);
    expect(
      r.state.events.some((e) => e.type === 'response-rejected' && e.nodeId === 'assess'),
    ).toBe(false);
  });

  it('a skeptic raises at most 5 objections a round', () => {
    const many: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        challenge: (s, v) => ({
          ...agents.challenge!(s, v),
          updates: {
            objections: ['S1: F1 a', 'S1: F1 b', 'S1: F1 c', 'S1: F1 d', 'S1: F1 e', 'S1: F1 f'],
          },
        }),
      },
    };
    const { r } = play(2, many);
    expect(
      r.state.events.some(
        (e) =>
          e.type === 'response-rejected' &&
          e.nodeId === 'challenge' &&
          /at most 5/.test(e.errors.join()),
      ),
    ).toBe(true);
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

  it('rejects hypotheses without a "none of these" or "premise is wrong" rival', () => {
    let proposals = 0;
    const narrow: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        hypothesize: (s, v) =>
          proposals++ === 0
            ? {
                ...agents.hypothesize!(s, v),
                updates: {
                  hypotheses: [
                    'H1: a | confirm if x | refute if y',
                    'H2: b | confirm if z | refute if w',
                  ],
                  ratedComplexity: 2,
                },
              }
            : agents.hypothesize!(s, v),
      },
    };
    const { r } = play(2, narrow);
    expect(r.state.outcome).toBe('success');
    const rejected = r.state.events.flatMap((e) => (e.type === 'response-rejected' ? [e] : []));
    expect(
      rejected.some((e) => e.nodeId === 'hypothesize' && /premise is wrong/.test(e.errors.join())),
    ).toBe(true);
  });
});

const rejections = (r: { state: { events: readonly EngineEvent[] } }, node: string) =>
  r.state.events.flatMap((e) =>
    e.type === 'response-rejected' && e.nodeId === node ? [e.errors.join()] : [],
  );

describe('the debate remembers its earlier rounds', () => {
  /** A skeptic that raises these objections, round by round (then nothing). */
  const skeptic = (rounds: string[][], inputs: Record<string, unknown>[] = []): DemoScript => ({
    ...demo,
    agents: {
      ...agents,
      chase: finding,
      challenge: (s, v) => {
        inputs.push({ ...s });
        return { ...agents.challenge!(s, v), updates: { objections: rounds[v] ?? [] } };
      },
    },
  });

  it('the next skeptic reads past objections and their triage', () => {
    const inputs: Record<string, unknown>[] = [];
    const { r } = play(3, skeptic([['S1: x was never read (F1)'], []], inputs));
    expect(r.state.outcome).toBe('success');
    expect(inputs[0]!.pastObjections).toEqual([]);
    expect(inputs[1]!.pastObjections).toEqual(['S1: x was never read (F1)']);
    expect(String(inputs[1]!.objectionTriage)).toMatch(/REAL/);
    expect(inputs[1]!.openObjections).toEqual(['S1: x was never read (F1)']);
    expect(r.state.state.debateLog).toEqual([
      expect.stringMatching(
        /^Round 1: 1 of 1 objections sent to research \(on S1\), \d+ findings so far$/,
      ),
    ]);
  });

  it('a word-for-word repeat is reported as unresolved, not asked again or researched again', () => {
    const repeat = 'S1: x was never read (F1)';
    const { r, ran, state } = play(3, skeptic([[repeat], [repeat]]));
    expect(rejections(r, 'challenge')).toEqual([]);
    expect(r.state.kind).toBe('done');
    expect(r.state.outcome).toBe('partial');
    expect(state.unresolvedObjections).toEqual([repeat]);
    // Researched once (round 1), not again.
    expect(state.debateRounds).toBe(1);
    expect(ran('challenge')).toBe(2);
  });

  it('a mixed round sets the repeats aside (open) and goes on with the new ones', () => {
    const old = 'S1: x was never read (F1)';
    const fresh = 'S2: "keeps the same move key" has no finding (F2)';
    const inputs: Record<string, unknown>[] = [];
    const { state } = play(3, skeptic([[old], [old, fresh], []], inputs));
    expect(state.unresolvedObjections).toEqual([old]);
    // Only the new one reached the pragmatist and research.
    expect(state.pastObjections).toEqual([old, fresh]);
    expect(state.debateRounds).toBe(2);
  });

  it('another round only when the last one found something new; the log says why it stopped', () => {
    const rounds = [
      ['S1: x was never read (F1)'],
      ['S1: nobody read x (F1)'],
      ['S1: x is unread (F1)'],
    ];
    const barren: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        // Research that finds the same thing every time: nothing new after the first round.
        challenge: (s, v) => ({
          ...agents.challenge!(s, v),
          updates: { objections: rounds[v] ?? [] },
        }),
      },
    };
    const { r, state } = play(3, barren);
    expect(state.debateRounds).toBe(1);
    expect(state.debateRounds).toBeLessThan(state.maxDebateRounds as number);
    expect(state.debateLog).toEqual([
      expect.stringMatching(/^Round 1: /),
      "Stopped after 1 round(s): the last round's research found nothing new; 1 objection(s) reported as open",
    ]);
    expect(r.state.outcome).toBe('partial');
  });

  it('a reworded repeat still runs to the cap', () => {
    const { r, state } = play(
      3,
      skeptic([
        ['S1: x was never read (F1)'],
        ['S1: nobody read x (F1)'],
        ['S1: x is unread (F1)'],
        ['S1: x stays unread (F1)'],
      ]),
    );
    expect(rejections(r, 'challenge')).toEqual([]);
    expect(state.debateRounds).toBe(state.maxDebateRounds);
    expect(r.state.steps.filter((x) => x.nodeId === 'challenge')).toHaveLength(3);
  });

  it("a pragmatist's reason names its ground (an F-id or S<n>), and only F-ids that exist", () => {
    let calls = 0;
    const script: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        triageObjections: (s, v) => {
          calls += 1;
          const good = agents.triageObjections!(s, v);
          const objections = s.objections as string[];
          const reason = calls === 1 ? 'REAL — it matters' : calls === 2 ? 'REAL — see F999' : '';
          return reason
            ? {
                ...good,
                updates: {
                  ...good.updates,
                  objectionTriage: objections.map((o) => `${o}: ${reason}`),
                },
              }
            : good;
        },
      },
    };
    const { r } = play(3, script);
    expect(r.state.outcome).toBe('success');
    const errors = rejections(r, 'triageObjections').join('\n');
    expect(errors).toMatch(/name what the reason rests on/);
    expect(errors).toMatch(/Cite only F-ids that are in findingsBrief/);
  });
});

describe('the skeptic', () => {
  it('works with read-only tools on another model family, and names what each objection attacks', () => {
    let calls = 0;
    const script: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        challenge: (s, v) => {
          calls += 1;
          const objections =
            calls === 1
              ? ['S2: the answer is vague about retries']
              : calls === 2
                ? [
                    'S2: "rejected answers keep their move key" is not backed',
                    'S1: F1 says nothing about schema',
                  ]
                : [];
          return { ...agents.challenge!(s, v), updates: { objections } };
        },
      },
    };
    const { r } = play(2, script);
    const pause = r.state.events.flatMap((e) =>
      e.type === 'paused' && e.pause.kind === 'agent' && e.pause.nodeId === 'challenge'
        ? [e.pause]
        : [],
    )[0]!;
    expect(pause.isolated).toBe(false);
    expect(pause.role).toBe('assessor');
    expect(pause.otherModel).toBe(true);
    expect(rejections(r, 'challenge').join()).toMatch(/Name what each objection attacks/);
    expect(r.state.state.pastObjections).toEqual([
      'S2: "rejected answers keep their move key" is not backed',
      'S1: F1 says nothing about schema',
    ]);
  });
});

describe('keepUnchallenged (an A/B option)', () => {
  /** An answer that rewrites every sub-answer each time, challenged or not. */
  const rewriting: DemoScript = {
    ...demo,
    agents: {
      ...agents,
      answer: (s, v) => {
        const good = agents.answer!(s, v);
        const subAnswers = ((s.subQuestions as string[]) ?? []).map(
          (_, i) => `S${i + 1}: rewritten (visit ${v}) [F1]`,
        );
        return { ...good, updates: { ...good.updates, subAnswers } };
      },
    },
  };
  const playWith = (keepUnchallenged: boolean) => {
    const score = compileInvestigate({
      context: { ...demo.context!, keepUnchallenged },
      complexity: 2,
      generatedAt: 't',
    });
    return runScripted(score, rewriting, { at: 't' });
  };

  it('off (default): a rewrite may change every sub-answer', () => {
    const r = playWith(false);
    expect(r.state.outcome).toBe('success');
    expect(rejections(r, 'answer')).toEqual([]);
  });

  it('on: a sub-answer no REAL objection named must stay word for word', () => {
    const r = playWith(true);
    // The demo's objection names S2: rewriting S1 is sent back (and the scripted answer
    // keeps rewriting, so the step ends stuck).
    expect(rejections(r, 'answer').join()).toMatch(
      /Keep every subAnswers entry that no entry of realObjections names/,
    );
  });

  it('on: rewriting only the challenged sub-answer is accepted', () => {
    const score = compileInvestigate({
      context: { ...demo.context!, keepUnchallenged: true },
      complexity: 2,
      generatedAt: 't',
    });
    const careful: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        answer: (s, v) => {
          const good = agents.answer!(s, v);
          const prev = (s.prevSubAnswers as string[]) ?? [];
          const tags = new Set(((s.realObjections as string[]) ?? []).map((o) => o.split(':')[0]));
          const subAnswers = ((s.subQuestions as string[]) ?? []).map((_, i) =>
            prev[i] && !tags.has(`S${i + 1}`)
              ? prev[i]!
              : `S${i + 1}: answered again (visit ${v}) [F1]`,
          );
          return { ...good, updates: { ...good.updates, subAnswers } };
        },
      },
    };
    const r = runScripted(score, careful, { at: 't' });
    expect(r.state.outcome).toBe('success');
    expect(rejections(r, 'answer')).toEqual([]);
    expect(r.state.state.subAnswers).toEqual([
      'S1: answered again (visit 0) [F1]',
      'S2: answered again (visit 1) [F1]',
    ]);
  });
});

describe('the answer meets every REAL objection by its tag', () => {
  it('a challenged answer resolves each objection; one left out is sent back', () => {
    let answers = 0;
    const script: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        answer: (s, v) => {
          const good = agents.answer!(s, v);
          answers += 1;
          // The first answer after the challenge forgets the objection.
          return answers === 2
            ? { ...good, updates: { ...good.updates, objectionResolutions: [] } }
            : good;
        },
      },
    };
    const { r, state } = play(2, script);
    expect(r.state.outcome).toBe('success');
    expect(rejections(r, 'answer').join()).toMatch(
      /one objectionResolutions entry per entry of realObjections/,
    );
    expect(state.objectionResolutions).toEqual([
      expect.stringMatching(/^S2: RESOLVED — .*\[F1\]$/),
    ]);
    // The parts are written against the same objections.
    const parts = r.state.steps.filter((x) => x.nodeId === 'answerParts');
    for (const p of parts) expect(p.input).toHaveProperty('realObjections');
  });

  it('an objection the answer cannot settle is an open question, and the run ends partial', () => {
    const script: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        answer: (s, v) => {
          const good = agents.answer!(s, v);
          const open = ((s.realObjections as string[]) ?? []).map(
            (o) => `${o.split(':')[0]}: OPEN — nothing found on the move key`,
          );
          return { ...good, updates: { ...good.updates, objectionResolutions: open } };
        },
      },
    };
    const { r, state } = play(2, script);
    expect(r.state.outcome).toBe('partial');
    expect(state.openQuestions).toContain('S2: OPEN — nothing found on the move key');
    expect(state.doubts).toEqual([
      'Objections the answer could not settle: S2: OPEN — nothing found on the move key',
    ]);
  });

  it('findings cited only in a sub-answer count as cited (memory and chains get them)', () => {
    const script: DemoScript = {
      ...demo,
      agents: {
        ...agents,
        answer: (s, v) => {
          const good = agents.answer!(s, v);
          const subAnswers = ((s.subQuestions as string[]) ?? []).map(
            (_, i) => `S${i + 1}: answered by the validation path [F${i === 0 ? 2 : 1}]`,
          );
          return { ...good, updates: { ...good.updates, subAnswers } };
        },
      },
    };
    const { r, state } = play(1, script);
    expect(r.state.outcome).toBe('success');
    expect(String(state.answer)).not.toMatch(/\[F2\]/);
    expect((state.citedFindings as string[]).map((f) => f.split(' ')[0])).toContain('F2');
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
      compileInvestigate({
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
    // The answer is one tier up, but on the top tier only in a complexity-4 run (shiftUpTo 3).
    expect(t.answer).toBe(3);
    expect(t.challenge).toBe(4);
    expect(tiers(auto(rate(4))).answer).toBe(4);
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

const answerErrors = (r: ReturnType<typeof play>['r']) =>
  r.state.events.flatMap((e) =>
    e.type === 'response-rejected' && e.nodeId === 'answer' ? e.errors : [],
  );

describe('flip-flops: a ruling that changes needs new evidence; one that goes back is UNKNOWN', () => {
  /** The skeptic objects every round and research finds something new each time. */
  const rounds = (h2: (visit: number, newest: string, call: number) => string): DemoScript => {
    let call = 0;
    return {
      ...demo,
      agents: {
        ...agents,
        chase: finding,
        challenge: (s, v) => ({
          ...agents.challenge!(s, v),
          updates: { objections: [`S1: F1 objection ${v}`] },
        }),
        answer: (s, v) => {
          const base = agents.answer!(s, v) as { updates: Record<string, unknown> };
          const findings = (s.findings as string[]) ?? [];
          const newest = findings.at(-1)!.split(' ')[0]!;
          const rulings = (base.updates.rulings as string[]).map((r) =>
            r.startsWith('H2:') ? h2(v, newest, call) : r,
          );
          call += 1;
          return { ...base, updates: { ...base.updates, rulings } } as never;
        },
      },
    };
  };

  it('a changed ruling citing only old evidence is sent back; citing a new finding it holds', () => {
    // Round 1 flips H2 on an old finding first, then on the finding research just found.
    let tries = 0;
    const { r, state } = play(
      3,
      rounds((v, newest) => {
        if (v === 0) return 'H2: REFUTED — no state change outside advance() [F1]';
        if (v === 1 && tries++ === 0) return 'H2: CONFIRMED — on a second look [F1]';
        return `H2: CONFIRMED — the new commit shows it [${newest}]`;
      }),
    );
    expect(answerErrors(r).join(' ')).toMatch(
      /A ruling that changes since the last answer must cite a finding found since then/,
    );
    expect(state.rulings).toContainEqual(expect.stringMatching(/^H2: CONFIRMED — the new commit/));
  });

  it('back to what an earlier answer said: only UNKNOWN is accepted', () => {
    let backTries = 0;
    const { r, state } = play(
      3,
      rounds((v, newest) => {
        if (v === 0) return 'H2: REFUTED — first look [F1]';
        if (v === 1) return `H2: CONFIRMED — round 1 found this [${newest}]`;
        // Round 2 goes back to REFUTED, with new evidence: the evidence goes both ways.
        return backTries++ === 0
          ? `H2: REFUTED — round 2 found this [${newest}]`
          : `H2: UNKNOWN — rounds 1 and 2 found evidence both ways [${newest}]`;
      }),
    );
    expect(answerErrors(r).join(' ')).toMatch(/goes back to what an earlier answer said/);
    expect(state.rulings).toContainEqual(expect.stringMatching(/^H2: UNKNOWN/));
  });
});
