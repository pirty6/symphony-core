import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { review } from './index.js';

const demo = review.demo!;
const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
type Agent = NonNullable<DemoScript['agents']>[string];

function play(over: Partial<DemoScript> = {}, context: Record<string, unknown> = {}) {
  const script: DemoScript = {
    ...demo,
    ...over,
    agents: { ...demo.agents, ...over.agents },
    tools: { ...demo.tools, ...over.tools },
  };
  const r = runScripted(
    compileScore(review, { goal: 'g', context: { ...demo.context, ...context } }),
    script,
  );
  return { r, state: r.state.state, end: r.state.cursor, ran: r.state.steps.map((s) => s.nodeId) };
}

const sound: Agent = (s) => ({
  updates: { newFindings: [], reviewed: (s.files as string[]) ?? [] },
  verdict: v,
});
const collecting =
  (files: string[], skipped: string[] = []): Agent =>
  () => ({
    updates: { diffSummary: 'd', claims: 'c', files, skipped, agents: 1 },
    verdict: v,
  });

describe('review', () => {
  it('runs the tests on the code first, and gives the reviewers the changed tests', () => {
    const { ran, state, end } = play({
      agents: { collect: collecting(['src/a.ts', 'src/a.test.ts'], ['pnpm-lock.yaml — lockfile']) },
    });
    expect(ran.indexOf('runTests')).toBeLessThan(ran.indexOf('analyze'));
    expect(state.changedTests).toEqual(['src/a.test.ts']);
    expect(end).toBe('issues');
    // What was left out, and why, is in the result.
    expect(state.coverage).toMatch(/Left out: pnpm-lock.yaml — lockfile/);
  });

  it('findings it cannot verify against this checkout are not "looks good"', () => {
    // E.g. the PR's branch is not checked out: every quote is rejected.
    const { r, state, end } = play({
      tools: { checkReview: (s) => ({ valid: [], invalid: s.newFindings }) },
    });
    expect(end).toBe('notVerified');
    expect(r.state.outcome).toBe('partial');
    expect(state.report).toMatch(/^Could not verify the review: 1 finding/);
    expect(state.report).toMatch(/check out the reviewed branch/);
  });

  it('a clean result is "looks good" only when every changed file was reviewed', () => {
    const clean = play({ agents: { analyze: sound } });
    expect(clean.end).toBe('clean');
    expect(clean.state.report).toMatch(/^No real issues found\. Reviewed: src\/core\/engine\.ts/);
    // Over maxFiles: the rest is named, and the run ends partial.
    const capped = play(
      { agents: { collect: collecting(['src/a.ts', 'src/b.ts', 'src/c.ts']), analyze: sound } },
      { maxFiles: 2 },
    );
    expect(capped.state.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(capped.end).toBe('partlyReviewed');
    expect(capped.r.state.outcome).toBe('partial');
    expect(capped.state.report).toMatch(/Not reviewed \(over maxFiles 2\): src\/c\.ts/);
  });

  it('failing tests are an issue even when no line is cited, and verify can be turned off', () => {
    const failing = play({
      agents: { analyze: sound },
      tools: {
        runTests: () => ({ passed: false, output: 'FAIL a.test.ts > adds', command: 'npm test' }),
      },
    });
    expect(failing.end).toBe('issues');
    expect(failing.ran).toContain('report');
    const off = play({ agents: { analyze: sound } }, { verify: false });
    expect(off.ran).not.toContain('runTests');
    expect(off.end).toBe('clean');
    expect(off.state.report).toMatch(/Tests not run \(verify is off\)/);
  });

  it('every finding names its category and severity', () => {
    const untagged = play({
      agents: {
        analyze: (s) => ({
          updates: {
            newFindings: ['src/core/engine.ts:120 — counter never resets `attempts += 1`'],
            reviewed: (s.files as string[]) ?? [],
          },
          verdict: v,
        }),
      },
    });
    expect(untagged.r.state.outcome).not.toBe('success');
    expect(JSON.stringify(untagged.r.state.steps.at(-1))).toMatch(/CATEGORY one of BUG, SECURITY/);
  });

  it('collects the diff fresh every time: a PR can change on GitHub', () => {
    expect(review.nodes.find((n) => n.id === 'collect')).toMatchObject({ fresh: true });
  });
});
