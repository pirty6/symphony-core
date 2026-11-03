import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { evaluateGuard } from '../core/expr.js';
import { toPerformance } from '../core/engine.js';
import { replayPerformance } from '../core/replay.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript, ScoreNode } from '../core/types.js';
import { fix, implement, refactor } from './index.js';

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
    const elsewhere = play({ agents: { diagnose: flakyDiagnose({ flakyFile: 'src/b.ts' }) } });
    expect(elsewhere.r.state.outcome).not.toBe('success');
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
/** A diff tool whose patch is new every attempt. */
const masked = (files: string[], diff: string) => () => {
  let k = 0;
  return () => ({ diff: `${diff} // ${++k}`, hash: `m${k}`, files });
};
const armed = { maxStabilityRuns: 1, stabilityTolerance: 0.25, maxEdits: 2 };
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

  it('edits that can hide a flake go to a person: unattended not certified, accepted certified with a note', () => {
    const cases: [string[], string, RegExp][] = [
      [
        ['src/eval/harness.ts'],
        '+++ b/src/eval/harness.ts\n+export const TIME_SLACK = 3;',
        /slack/,
      ],
      [['src/a.test.ts'], `+++ b/src/a.test.ts\n+  it.skip('loads in time')`, /own file/],
      [
        ['src/a.ts'],
        '--- a/src/a.ts\n-  expect(ms).toBeLessThan(10);\n+  run();',
        /assertions removed/,
      ],
      [['package.json'], '+++ b/package.json\n+  "test": "vitest run"', /configure the tests/],
    ];
    for (const [files, diff, flag] of cases) {
      const r = play(
        { agents: flaky, tools: { captureDiff: masked(files, diff)(), runStable: gateRuns()() } },
        armed,
      );
      expect((r.state.maskingFlags as string[]).join('; '), diff).toMatch(flag);
      expect(r.end).toBe('uncertified');
      expect(r.state.stabilityReport).toMatch(/did not accept the masking flags/);
    }
    const accepted = play(
      {
        agents: flaky,
        tools: {
          captureDiff: masked(...(cases[0]!.slice(0, 2) as [string[], string]))(),
          runStable: gateRuns()(),
        },
        approvals: { ...demo.approvals, maskingReview: () => ({ approved: true }) },
      },
      armed,
    );
    expect(accepted.end).toBe('fixed');
    expect(accepted.state.stabilityReport).toMatch(/^certified: .*a person accepted: added lines/);
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

  it('the worst case ends partial at the step limit, never Fixed', () => {
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
      { ...armed, maxEdits: 8, maxAttempts: 8 },
    );
    expect(r.r.state.outcome).toBe('partial');
    expect(r.end).not.toBe('fixed');
  });
});
