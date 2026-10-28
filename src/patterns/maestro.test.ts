import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript, Pattern } from '../core/types.js';
import { analyze, composedScore, maestro, maestroThen } from './index.js';

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

const classifyAs =
  (chosen: string, complexity: number, thenPattern = '') =>
  () => ({
    updates: { chosen, complexity, classifyReason: 'test', thenPattern },
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

  it('loops back to the proposer with validation errors, and gives up after maxRounds', () => {
    let proposals = 0;
    const { r } = run('do something new', {
      classify: classifyAs('new', 2),
      propose: (s) => ({
        updates: {
          draft:
            proposals++ === 0
              ? { name: 'broken' }
              : (demo.agents!.propose!(s, 0).updates.draft as object),
          assumptions: ['a'],
        },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      }),
    });
    expect(nodesRun(r).filter((n) => n === 'propose')).toHaveLength(2);
    expect(r.state.state.round).toBe(2);
    expect(r.state.outcome).toBe('success');

    const never = run('do something new', {
      classify: classifyAs('new', 2),
      propose: () => ({
        updates: { draft: { name: 'broken' }, assumptions: ['a'] },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      }),
    });
    expect(never.r.state.cursor).toBe('gaveUp');
    expect(never.r.state.outcome).toBe('failed');
  });

  it('go-gate feedback escalates complexity and runs another round', () => {
    let gates = 0;
    const { r } = run(
      'fix it',
      { classify: classifyAs('fix', 2) },
      {
        approvals: {
          gate: () => ({
            approved: true,
            updates: { feedback: gates++ === 0 ? 'also add a regression test' : '' },
          }),
        },
      },
    );
    expect(nodesRun(r).filter((n) => n === 'propose')).toHaveLength(2);
    expect(r.state.state).toMatchObject({ complexity: 3, round: 2 });
    expect(nodesRun(r)).toContain('pragmatist');
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
