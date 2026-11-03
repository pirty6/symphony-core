import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { evaluateGuard } from '../core/expr.js';
import { toPerformance } from '../core/engine.js';
import { replayPerformance } from '../core/replay.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript, ScoreNode } from '../core/types.js';
import { fix, implement, refactor } from './index.js';
import { FAILED_LINE, PASSED_LINE, RETRIED_LINE } from './phases/stability.js';

const demo = fix.demo!;
const agents = demo.agents!;
const tools = demo.tools!;
const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
type Agent = NonNullable<DemoScript['agents']>[string];

const TARGET = 'src/a.test.ts > main > loads in time';
/** vitest --reporter=verbose lines for the target and another test. */
const out = {
  targetFails: ` × ${TARGET} 12ms\n ✓ src/a.test.ts > main > other 1ms\n FAIL  ${TARGET}\n Tests  1 failed | 1 passed (2)`,
  otherFails: ` ✓ ${TARGET} 3ms\n × src/b.test.ts > b > unrelated\n FAIL  src/b.test.ts > b > unrelated\n Tests  1 failed | 1 passed (2)`,
};
const tests = (passed: boolean, output = passed ? `✓ ${TARGET} 2ms` : out.targetFails) => ({
  passed,
  output,
  command: 'npm test',
});

/** The demo's diagnosis, of an intermittent failure. */
const flakyDiagnose =
  (over: Record<string, unknown> = {}): Agent =>
  (s, visit) => {
    const base = (agents.diagnose as Agent)(s, visit);
    return {
      ...base,
      updates: {
        ...base.updates,
        nondeterministic: true,
        flakyTarget: TARGET,
        flakyFile: 'src/a.test.ts',
        fixTarget: 'CODE',
        ...over,
      },
    };
  };

function play(over: Partial<DemoScript> = {}, context: Record<string, unknown> = {}) {
  const script: DemoScript = {
    ...demo,
    ...over,
    agents: { ...agents, ...over.agents },
    tools: { ...tools, ...over.tools },
  };
  const score = compileScore(fix, { context: { ...demo.context, ...context }, generatedAt: 't' });
  const r = runScripted(score, script, { at: 't' });
  const ran = (id: string) => r.state.steps.filter((s) => s.nodeId === id).length;
  expect(replayPerformance(score, toPerformance(r.state)).divergence.reproduced).toBe(true);
  return { r, ran, state: r.state.state, end: r.state.cursor };
}

const node = (p: typeof fix, id: string) =>
  p.nodes.find((n) => n.id === id) as ScoreNode & {
    directive: string;
    checks: readonly unknown[];
    reads: readonly string[];
  };

describe('fix on a flaky test', () => {
  it('the diagnosis of an intermittent failure names the test, its file and where the fix goes', () => {
    const named = play({ agents: { diagnose: flakyDiagnose() } });
    expect(named.state).toMatchObject({ nondeterministic: true, flakyTarget: TARGET });
    const unnamed = play({ agents: { diagnose: flakyDiagnose({ flakyTarget: '' }) } });
    expect(unnamed.r.state.outcome).not.toBe('success');
    expect(JSON.stringify(unnamed.r.state.steps.at(-1))).toMatch(/needs flakyTarget/);
    const noFile = play({ agents: { diagnose: flakyDiagnose({ flakyFile: '' }) } });
    expect(noFile.r.state.outcome).not.toBe('success');
  });

  it("the target's own failure is never ENVIRONMENT; another test's may be", () => {
    const environmental = {
      diagnose: flakyDiagnose(),
      triage: () => ({
        updates: { failureKind: 'ENVIRONMENT', failureReason: 'flaky' },
        verdict: v,
      }),
    };
    const target = play({ agents: environmental, tools: { runTests: () => tests(false) } });
    expect(target.ran('recheckEnv')).toBe(0);
    expect(JSON.stringify(target.r.state.steps.at(-1))).toMatch(/did not make it stable/);
    const other = play({
      agents: environmental,
      tools: { runTests: () => tests(false, out.otherFails) },
    });
    expect(other.ran('recheckEnv')).toBe(1);
  });

  it("reads a test's own result line from vitest, node and pytest output", () => {
    // Captured from vitest 4.1.10 --reporter=verbose, node --test (spec and TAP) and pytest -v.
    const lines: [string, 'failed' | 'passed' | 'retried' | 'neither'][] = [
      [' × a.test.ts > main > flaky one 2ms', 'failed'],
      [' FAIL  a.test.ts > main > flaky one', 'failed'],
      [' ✓ a.test.ts > main > stable one 1ms', 'passed'],
      [' ✓ a.test.ts > main > retried 1ms (retry x1)', 'retried'],
      [' ↓ a.test.ts > main > skipped one', 'neither'],
      ['✖ bad one (0.368667ms)', 'failed'],
      ['✔ a > ok one (0.327916ms)', 'passed'],
      ['not ok 2 - bad one', 'failed'],
      ['ok 1 - a > ok one', 'passed'],
      ['ok 3 - skipped one # SKIP', 'neither'],
      ['tests/test_a.py::test_b FAILED', 'failed'],
      ['tests/test_a.py::test_b PASSED', 'passed'],
      ['tests/test_a.py::test_b RERUN', 'retried'],
    ];
    for (const [line, is] of lines) {
      const got = new RegExp(RETRIED_LINE).test(line)
        ? 'retried'
        : new RegExp(FAILED_LINE).test(line)
          ? 'failed'
          : new RegExp(PASSED_LINE).test(line)
            ? 'passed'
            : 'neither';
      expect(got, line).toBe(is);
    }
  });

  it('the nondeterminism checklist and the masking rule are fix-only: implement and refactor are unchanged', () => {
    for (const id of ['research', 'diagnose']) {
      expect(node(fix, id).directive).toMatch(/state shared between tests/);
    }
    expect(node(fix, 'apply').directive).toMatch(/Do not hide a failure/);
    expect(node(fix, 'triage').directive).toMatch(/flakyTarget/);
    for (const p of [implement, refactor]) {
      expect(node(p, 'apply').directive).not.toMatch(/Do not hide a failure/);
      expect(node(p, 'triage').directive).not.toMatch(/flakyTarget/);
      expect(node(p, 'triage').checks).toHaveLength(2);
      expect(node(p, 'prReview').reads).not.toContain('maskingFlags');
    }
  });
});

type State = Readonly<Record<string, unknown>>;
/** Gate runs: the flaky test passes, unless `fails` says this run fails. */
const gateRuns =
  (fails: (s: State, run: number) => boolean = () => false, passOutput = `✓ ${TARGET} 2ms`) =>
  () => {
    let run = 0;
    return (s: State) =>
      fails(s, ++run) ? tests(false, out.targetFails) : tests(true, passOutput);
  };

/** maxStabilityRuns 1 is raised to runsNeeded(0.25, maxEdits 2) = 13. */
/** A file's header in git.diff's output. */
const head = (f: string) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@`;
/** A diff tool whose patch is new every attempt. */
const masked = (files: string[], diff: string) => () => {
  let k = 0;
  return () => ({ diff: `${diff} // ${++k}`, hash: `m${k}`, files });
};
const armed = { maxStabilityRuns: 1, stabilityTolerance: 0.25, maxEdits: 2 };
/** Edits that can hide a flake, and the flag each raises. */
const MASKING_CASES: [string[], string, RegExp][] = [
  [
    ['src/eval/harness.ts'],
    `${head('src/eval/harness.ts')}\n+export const TIME_SLACK = 3;`,
    /slack/,
  ],
  [['src/a.ts'], `${head('src/a.ts')}\n+  await sleep(50);`, /code touches/],
  [['src/a.test.ts'], `${head('src/a.test.ts')}\n+  it.skip('another', () => {});`, /skip, invert/],
  [['src/a.test.ts'], `${head('src/a.test.ts')}\n+  it('x', { retry: 3 }, () => {});`, /own file/],
  [['src/b.test.ts'], `${head('src/b.test.ts')}\n+jest.retryTimes(3);`, /retry/],
  [['test/b.js'], `${head('test/b.js')}\n+  this.retries(3);`, /retry/],
  [['tests/test_b.py'], `${head('tests/test_b.py')}\n+@pytest.mark.flaky(reruns=3)`, /retry/],
  [
    ['src/my thing.test.ts'],
    `${head('src/a.ts')}\n+ok()\ndiff --git a/src/my thing.test.ts b/src/my thing.test.ts\n--- a/src/my thing.test.ts\n+++ b/src/my thing.test.ts\n@@ -1 +1 @@\n+it.skip('x')`,
    /skip, invert/,
  ],
  [
    ['src/a.test.ts'],
    `${head('src/a.test.ts')}\n-  it('loads in time', async () => {\n+  it('loads in time', async () => { // ok`,
    /existing test lines/,
  ],
  [
    ['src/a.ts'],
    `${head('src/a.ts')}\n-  expect(ms).toBeLessThan(10);\n+  run();`,
    /assertions removed/,
  ],
  [['package.json'], `${head('package.json')}\n+  "test": "vitest run"`, /configure the tests/],
  [['img.png'], 'untracked files:\n  img.png', /cannot show/],
];
const flaky = { diagnose: flakyDiagnose() };

describe('fix: the stability gate (opt-in)', () => {
  it('is off by default: three steps with no I/O, the same test runs and the same end', () => {
    for (const r of [play(), play({ agents: flaky })]) {
      const ids = r.r.state.steps.map((x) => x.nodeId);
      expect(ids).toEqual(expect.arrayContaining(['armStability', 'controlOn', 'stableGate']));
      for (const id of ['controlSnapshot', 'runControl', 'runStable', 'checkMasking'])
        expect(r.ran(id)).toBe(0);
      expect(r.end).toBe('fixed');
      expect(r.ran('runTests')).toBe(2);
      expect(r.state.stabilityReport).toBe('');
    }
  });

  it('armed: the flake fails before the edit, then the patch passes the runs the tolerance needs: certified', () => {
    for (const ctx of [armed, { ...armed, maxStabilityRuns: 0, autoStabilityRuns: 1 }]) {
      const r = play({ agents: flaky, tools: { runStable: gateRuns()() } }, ctx);
      expect(r.state.maxStableRuns).toBe(13);
      expect(r.ran('runControl')).toBe(1);
      expect(r.ran('runStable')).toBe(13);
      const ids = r.r.state.steps.map((x) => x.nodeId);
      expect(ids.indexOf('runControl')).toBeLessThan(ids.indexOf('apply'));
      expect(r.end).toBe('fixed');
      expect(r.state.stabilityReport).toMatch(
        /^certified: .* failed 1 of 1 runs .* none of 13 fresh runs .* below 0\.25 at 95% across 2 patches/,
      );
      expect(r.state.certifiedHashes).toEqual([r.state.diffHash]);
    }
    // Each run is a sample: neither the control nor the gate reuses a result.
    for (const id of ['runControl', 'runStable'])
      expect((fix.nodes.find((n) => n.id === id) as { args?: unknown }).args).toBeUndefined();
  });

  it('a failure of the flaky test after verify goes back to the edit loop, never to ENVIRONMENT', () => {
    const ctx = { ...armed, maxEdits: 3 };
    const r = play({ agents: flaky, tools: { runStable: gateRuns((_s, n) => n === 3)() } }, ctx);
    expect(r.state.maxStableRuns).toBe(15);
    expect(r.state.unstableHash).toBe('diff-2');
    expect(r.ran('apply')).toBe(3);
    expect(r.ran('runStable')).toBe(3 + 15);
    expect(r.end).toBe('fixed');
    // Unattended or not, the triage may not file it as an environment problem.
    const env = play(
      {
        agents: {
          ...flaky,
          triage: () => ({
            updates: { failureKind: 'ENVIRONMENT', failureReason: 'flaky' },
            verdict: v,
          }),
        },
        tools: { runStable: gateRuns((_s, n) => n === 3)() },
      },
      ctx,
    );
    expect(env.ran('recheckEnv')).toBe(1);
    expect(env.end).not.toBe('fixed');
    expect(JSON.stringify(env.r.state.steps.at(-1))).toMatch(/stability gate ran this patch again/);
  });

  it('a retry or an unseen result is not a clean run', () => {
    const retried = play(
      { agents: flaky, tools: { runStable: gateRuns(undefined, `✓ ${TARGET} 2ms (retry x1)`)() } },
      { ...armed, maxEdits: 3 },
    );
    expect(retried.state.stableTargetFails).toBeGreaterThan(0);
    // The default reporter under CI prints no passing tests: the gate cannot see the target.
    const unseen = play(
      { agents: flaky, tools: { runStable: gateRuns(undefined, ' Tests  2 passed (2)')() } },
      armed,
    );
    expect(unseen.ran('runStable')).toBe(4);
    expect(unseen.end).toBe('uncertified');
    expect(unseen.state.stabilityReport).toMatch(/too many gate runs were inconclusive \(4 of 4\)/);
  });

  it('with no failure before the edit a person decides; unattended it stops, approved it is not certified', () => {
    const ctx = { ...armed, maxControlRuns: 3 };
    const passing = { runControl: () => tests(true), runStable: gateRuns()() };
    const stop = play({ agents: flaky, tools: passing }, ctx);
    expect(stop.ran('runControl')).toBe(3);
    expect(stop.end).toBe('flakeNotShown');
    expect(stop.ran('apply')).toBe(0);
    const anyway = play(
      {
        agents: flaky,
        tools: { ...passing, runStable: gateRuns()() },
        approvals: { ...demo.approvals, notReproduced: () => ({ approved: true }) },
      },
      ctx,
    );
    expect(anyway.end).toBe('uncertified');
    expect(anyway.r.state.outcome).toBe('partial');
    expect(anyway.ran('prReview')).toBe(0);
    expect(anyway.ran('learnUncertified')).toBe(1);
    expect(anyway.state.stabilityReport).toMatch(/did not fail in 3 control runs/);
  });

  it('a control after an edit (a re-diagnosis) proves nothing: not certified', () => {
    let k = 0;
    let t = 0;
    const r = play(
      {
        agents: {
          diagnose: (s, visit) =>
            visit === 0 ? agents.diagnose!(s, visit) : flakyDiagnose()(s, visit),
          triage: () => ({
            updates: { failureKind: 'DIAGNOSIS', failureReason: 'flaky' },
            verdict: v,
          }),
        },
        tools: {
          captureDiff: () => ({ diff: `patch ${++k}`, hash: `h${k}`, files: ['src/paginate.ts'] }),
          runTests: () => tests(t++ > 0),
          runStable: gateRuns()(),
        },
      },
      { ...armed, maxStabilityRuns: 0, autoStabilityRuns: 1 },
    );
    expect(r.ran('noControl')).toBe(1);
    expect(r.ran('runControl')).toBe(0);
    expect(r.end).toBe('uncertified');
    expect(r.state.stabilityReport).toMatch(/no control: the gate started after an edit/);
  });

  it('armed late, by a failure that passes when run again: measured, but not certified without a control', () => {
    let n = 0;
    const r = play(
      {
        agents: {
          triage: () => ({
            updates: { failureKind: 'ENVIRONMENT', failureReason: 'flaky' },
            verdict: v,
          }),
        },
        tools: { runTests: () => tests(n++ > 0, n > 1 ? 'ok' : 'FAIL x'), runStable: gateRuns()() },
      },
      { autoStabilityRuns: 1, stabilityTolerance: 0.25, maxEdits: 2 },
    );
    expect(r.ran('recheckEnv')).toBe(1);
    expect(r.ran('runStable')).toBe(13);
    expect(r.end).toBe('uncertified');
    expect(r.state.stabilityReport).toMatch(/no flaky test was named/);
  });

  // One case per test: each plays a whole gated run.
  it.each(MASKING_CASES.map((c) => [c[2].source, ...c] as const))(
    'edits that can hide a flake go to a person, unattended not certified: %s',
    (_name, files, diff, flag) => {
      const r = play(
        { agents: flaky, tools: { captureDiff: masked(files, diff)(), runStable: gateRuns()() } },
        armed,
      );
      expect((r.state.maskingFlags as string[]).join('; '), diff).toMatch(flag);
      expect(r.end).toBe('uncertified');
      expect(r.state.stabilityReport).toMatch(/did not accept the masking flags/);
    },
  );

  it('a person who accepts the flags certifies the patch, with a note', () => {
    const accepted = play(
      {
        agents: flaky,
        tools: {
          captureDiff: masked(...(MASKING_CASES[0]!.slice(0, 2) as [string[], string]))(),
          runStable: gateRuns()(),
        },
        approvals: { ...demo.approvals, maskingReview: () => ({ approved: true }) },
      },
      armed,
    );
    expect(accepted.end).toBe('fixed');
    expect(accepted.state.stabilityReport).toMatch(/^certified: .*a person accepted: added code/);
  });

  it('a regression test in a new file is not flagged; next to the flaky test, a person looks', () => {
    // A root-cause fix plus a new regression test (with a sleep to order the answers). In a new
    // file: nothing to flag, certified unattended. Next to the flaky test: a person looks, since
    // a retry or a sleep added there would look the same.
    const regression = (testFile: string) =>
      play(
        {
          agents: flaky,
          tools: {
            captureDiff: masked(
              ['src/search.js', testFile],
              `${head('src/search.js')}\n-  let shown = '';\n+  const results = await Promise.all(queries.map((q) => fetch(q)));\n${head(testFile)}\n+test('ignores stale answers', async () => {\n+    await sleep(delays[q]);\n+  assert.equal(await typeAhead(['a', 'ab', 'abc'], ordered), 'ABC');\n+});`,
            )(),
            runStable: gateRuns()(),
          },
        },
        armed,
      );
    const newFile = regression('src/a.regression.test.ts');
    expect(newFile.state.maskingFlags).toEqual([]);
    expect(newFile.end).toBe('fixed');
    expect(regression('src/a.test.ts').state.maskingFlags).toEqual([
      "the flaky test's own file changed",
    ]);
  });

  it('a certificate holds only for the patch it measured', () => {
    const certifiable = (fix.nodes.find((n) => n.id === 'certifiable') as { expression: string })
      .expression;
    const measured = {
      flakyTarget: TARGET,
      reproductionProved: true,
      controlTarget: TARGET,
      controlCommand: 'c',
      gateCommand: 'c',
      stableTargetFails: 0,
      stabilityRuns: 13,
      stableInconclusive: 0,
      maxStableRuns: 13,
      stableHash: 'a',
      diffHash: 'a',
    };
    expect(evaluateGuard(certifiable, measured)).toBe(true);
    expect(evaluateGuard(certifiable, { ...measured, diffHash: 'b' })).toBe(false);
    expect(evaluateGuard(certifiable, { ...measured, gateCommand: 'other' })).toBe(false);
    expect(evaluateGuard(certifiable, { ...measured, stableInconclusive: 1 })).toBe(false);
  });

  it('accepting the reviewed patch needs a certificate for that patch when the gate is on', () => {
    const expr = (fix.nodes.find((n) => n.id === 'reviewedCertified') as { expression: string })
      .expression;
    const at = (o: State) =>
      evaluateGuard(expr, {
        stabilityArmed: true,
        certifiedHashes: ['a'],
        reviewedHash: 'a',
        ...o,
      });
    expect(at({})).toBe(true);
    expect(at({ reviewedHash: 'b' })).toBe(false);
    expect(at({ stabilityArmed: false, reviewedHash: 'b' })).toBe(true);
  });

  it('an ordinary armed run fits the step budget: a late control failure, a gate failure and a review round', () => {
    let k = 0;
    let control = 0;
    const r = play(
      {
        agents: {
          ...flaky,
          prReview: (_s, visit) => ({
            updates:
              visit === 0
                ? {
                    reviewDecision: 'REQUEST_CHANGES',
                    reviewComments: ['BLOCKING src/paginate.ts:7 — name the constant'],
                    reviewSummary: 'one change',
                  }
                : {
                    reviewDecision: 'APPROVE',
                    reviewComments: ['RESOLVED src/paginate.ts:7 — named'],
                    reviewSummary: 'ok',
                  },
            verdict: v,
          }),
        },
        tools: {
          captureDiff: () => ({ diff: `patch ${++k}`, hash: `h${k}`, files: ['src/paginate.ts'] }),
          runControl: () => tests(++control < 8, control < 8 ? `✓ ${TARGET} 2ms` : out.targetFails),
          runStable: gateRuns((_s, n) => n === 20)(),
        },
      },
      // The defaults: tolerance 0.1 across 8 patches, 49 runs.
      { autoStabilityRuns: 1 },
    );
    expect(r.state.maxStableRuns).toBe(49);
    expect(r.ran('runControl')).toBe(8);
    expect(r.ran('prReview')).toBe(2);
    expect(r.end).toBe('fixed');
  });

  // Plays a whole run up to the 1000-step limit: about 3 s alone, more on a loaded runner.
  it('the worst case ends at the step limit or out of edits, never Fixed', () => {
    let k = 0;
    const r = play(
      {
        agents: flaky,
        tools: {
          captureDiff: () => ({ diff: `patch ${++k}`, hash: `h${k}`, files: ['src/paginate.ts'] }),
          // The flaky test fails on the last gate run of every patch.
          runStable: gateRuns(
            (s) => (s.stabilityRuns as number) === (s.maxStableRuns as number) - 1,
          )(),
        },
      },
      { autoStabilityRuns: 1, maxAttempts: 8 },
    );
    expect(r.r.state.outcome).not.toBe('success');
    expect(r.r.state.steps.length).toBeLessThanOrEqual(fix.maxSteps!);
  }, 30_000);

  it('once armed, a re-diagnosis that no longer calls it intermittent does not disarm the gate', () => {
    let k = 0;
    const r = play(
      {
        agents: {
          diagnose: (s, visit) =>
            visit === 0 ? flakyDiagnose()(s, visit) : agents.diagnose!(s, visit),
          triage: () => ({
            updates: { failureKind: 'DIAGNOSIS', failureReason: 'flaky' },
            verdict: v,
          }),
        },
        tools: {
          captureDiff: () => ({ diff: `patch ${++k}`, hash: `h${k}`, files: ['src/paginate.ts'] }),
          runTests: () => tests(true),
          runStable: gateRuns((_s, n) => n === 3)(),
        },
      },
      { ...armed, maxStabilityRuns: 0, autoStabilityRuns: 1 },
    );
    expect(r.state.stabilityArmed).toBe(true);
    expect(r.ran('diagnose')).toBe(2);
    expect(r.end).not.toBe('fixed');
    expect(r.state.certifiedHashes).toEqual([]);
  });

  it('reads node --test results by the test name alone (spec and TAP)', () => {
    const name = 'shows the answer to the latest query';
    for (const [failed, passed] of [
      [`✖ ${name} (1.0ms)\n✖ failing tests:\ntest at test/search.test.js:5:1`, `✔ ${name} (2.1ms)`],
      [`not ok 1 - ${name}\n# fail 1`, `ok 1 - ${name}\n# pass 1`],
    ] as const) {
      let c = 0;
      const r = play(
        {
          agents: {
            diagnose: flakyDiagnose({ flakyTarget: name, flakyFile: 'test/search.test.js' }),
          },
          tools: {
            runControl: () => tests(++c > 1, c > 1 ? passed : failed),
            runStable: () => tests(true, passed),
          },
        },
        armed,
      );
      expect(r.ran('runControl'), failed).toBe(1);
      expect(r.end).toBe('fixed');
    }
  });
});
