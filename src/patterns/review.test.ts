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

  it('a part that could not read its files does not throw away the others', () => {
    const { r, state, end } = play(
      {
        agents: {
          collect: collecting(['src/a.ts', 'src/b.ts']),
          analyze: (s) =>
            (s.files as string[])[0] === 'src/b.ts'
              ? {
                  updates: { newFindings: [], reviewed: [] },
                  verdict: { ...v, outcome: 'failed', reason: 'could not read it' },
                }
              : {
                  updates: {
                    newFindings: ['src/a.ts:3 — [BUG] [HIGH] off by one `i < n`'],
                    reviewed: ['src/a.ts'],
                  },
                  verdict: v,
                },
        },
      },
      { filesPerAgent: 1 },
    );
    expect(end).toBe('issues');
    expect(state.findings).toEqual(['F1 src/a.ts:3 — [BUG] [HIGH] off by one `i < n`']);
    expect(state.coverage).toMatch(/Not reviewed \(the reviewer could not read them\): src\/b\.ts/);
    expect(r.state.outcome).toBe('success');
  });

  it('checks that did not run say why, and keep the command you gave', () => {
    const notRun = {
      passed: true,
      output: 'not run: remote callers do not run commands here',
      command: '',
    };
    const { state, end } = play(
      {
        agents: { analyze: sound, collect: collecting(['src/a.ts'], ['src/old.ts — deleted']) },
        tools: { runTests: () => notRun, runLint: () => notRun },
      },
      { testCommand: 'pnpm test', lintCommand: 'tsc --noEmit' },
    );
    expect(state.testCommand).toBe('pnpm test');
    expect(state.coverage).toMatch(/Tests not run: remote callers/);
    expect(state.coverage).toMatch(/Lint not run: remote callers/);
    expect(state.coverage).toMatch(/Left out: src\/old\.ts — deleted/);
    expect(end).toBe('clean');
  });

  it('runs the tests afresh each time, never from a cached run', () => {
    const node = review.nodes.find((n) => n.id === 'runTests') as {
      args?: Record<string, unknown>;
    };
    expect(node.args).toEqual({ optional: true });
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

describe('review of a pull request', () => {
  const pr = {
    number: 7,
    base: 'abc123',
    files: ['M\tsrc/a.ts', 'D\tsrc/old.ts'],
    paths: ['src/a.ts', 'src/old.ts'],
    error: '',
  };

  it('reads the PR the engine checked out, and accounts for each of its files', () => {
    const { ran, state } = play({
      tools: { prInfo: () => pr },
      agents: { collect: collecting(['src/a.ts'], ['src/old.ts — deleted']) },
    });
    expect(ran.slice(0, 4)).toEqual(['start', 'prInfo', 'prFetched', 'collect']);
    expect(state).toMatchObject({ prNumber: 7, prBase: 'abc123', prPaths: pr.paths });
    expect(ran).toContain('analyze');
    expect(review.nodes.find((n) => n.id === 'collect')).toMatchObject({
      reads: expect.arrayContaining(['prBase', 'prFiles']),
    });
  });

  it('a file the PR does not change, or one left unaccounted, is sent back by name', () => {
    let calls = 0;
    const { r } = play({
      tools: { prInfo: () => pr },
      agents: {
        collect: (s) =>
          [
            collecting(['src/a.ts', 'src/other.ts']),
            // The deleted file forgotten.
            collecting(['src/a.ts']),
            collecting(['src/a.ts'], ['src/old.ts — deleted']),
          ][calls++]!(s, 0),
      },
    });
    const collect = r.state.steps.find((s) => s.nodeId === 'collect')!;
    const [outside, forgotten] = collect.attempts!.map((a) => a.errors.join(' '));
    expect(outside).toMatch(/Not allowed: "src\/other\.ts"/);
    expect(outside).not.toMatch(/Account for every file/);
    expect(forgotten).toMatch(/Account for every file the PR changes/);
    expect(calls).toBe(3);
    expect(r.state.steps.map((x) => x.nodeId)).toContain('analyze');
  });

  it('a PR that could not be fetched ends "Could not review" with why, before any AI step', () => {
    const { r, state, end, ran } = play({
      tools: {
        prInfo: () => ({
          ...pr,
          base: '',
          files: [],
          paths: [],
          error: "could not fetch refs/pull/7/merge from 'origin' (Authentication failed)",
        }),
      },
    });
    expect(end).toBe('notReviewed');
    expect(r.state.outcome).toBe('failed');
    expect(ran).not.toContain('collect');
    expect(state.report).toBe(
      "Could not review: could not fetch refs/pull/7/merge from 'origin' (Authentication failed).",
    );
  });

  it('no diff says why in the report, not an empty one', () => {
    const { state, end } = play({
      agents: {
        collect: () => ({
          updates: {
            diffSummary: 'Could not retrieve the diff for PR 5952552: no access.',
            claims: '',
            files: [],
            skipped: [],
            agents: 1,
          },
          verdict: v,
        }),
      },
    });
    expect(end).toBe('noDiff');
    expect(state.report).toBe(
      'Could not review: Could not retrieve the diff for PR 5952552: no access.',
    );
  });
});

describe('review: a version for people and a brief for an AI agent', () => {
  it('each end says how the review ended, in the brief, and the run still ends there', () => {
    const issues = play();
    expect(issues.end).toBe('issues');
    expect(String(issues.state.handoff)).toMatch(/## Status\n\nIssues found/);
    expect(String(issues.state.summary)).toMatch(/^## In short/);
    const clean = play({ agents: { analyze: sound } });
    expect(clean.end).toBe('clean');
    expect(String(clean.state.handoff)).toMatch(/## Status\n\nLooks good/);
    const unverified = play({
      tools: { checkReview: (s) => ({ valid: [], invalid: s.newFindings }) },
    });
    expect(unverified.end).toBe('notVerified');
    expect(unverified.r.state.outcome).toBe('partial');
    expect(String(unverified.state.handoff)).toMatch(/## Status\n\nNot verified/);
  });

  it('the brief has the findings, what not to rely on, the coverage and what to do; people come first', () => {
    const { state } = play();
    const brief = String(state.handoff);
    for (const h of [
      '## Task',
      '## Instructions for the next agent',
      '## Findings (checked against the code)',
      '## Do not rely on',
      '## Coverage',
      '## The review as written',
    ])
      expect(brief).toContain(h);
    for (const f of state.findings as string[]) expect(brief).toContain(`- ${f}`);
    expect(review.result).toEqual(['summary', 'handoff']);
    const off = play({}, { plainSummary: false });
    expect(off.ran).not.toContain('explain');
    expect(off.end).toBe('issues');
  });
});
