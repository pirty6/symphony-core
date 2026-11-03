import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
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
