import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { replayPerformance } from '../core/replay.js';
import { toPerformance } from '../core/engine.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { fix } from './index.js';

const demo = fix.demo!;
const agents = demo.agents!;
const tools = demo.tools!;
const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
const tests = (passed: boolean, output = passed ? 'ok' : 'FAIL x') => ({
  passed,
  output,
  command: 'npm test',
});

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

/** A diff tool that changes the patch every attempt (progress), counting calls. */
const freshDiff = () => {
  let n = 0;
  return () => ({ diff: `patch ${++n}`, hash: `h${n}`, files: ['src/paginate.ts'] });
};

describe('fix', () => {
  it('diagnoses with competing hypotheses, then the engine verifies: fails once, fixed on retry', () => {
    const { r, ran, state, end } = play();
    expect(r.state.outcome).toBe('success');
    expect(end).toBe('fixed');
    expect(ran('hypothesize')).toBe(1);
    expect(ran('challenge')).toBe(1);
    expect(ran('apply')).toBe(2);
    expect(ran('runTests')).toBe(2);
    expect(ran('triage')).toBe(1);
    expect(state.testsPassed).toBe(true);
    expect((state.rulings as string[]).length).toBe((state.hypotheses as string[]).length);
    expect(state.changedFiles).toEqual(['src/paginate.test.ts', 'src/paginate.ts']);
  });

  it('shows the root cause, rulings, files and plan at the approval', () => {
    const approve = fix.nodes.find((n) => n.id === 'approve');
    expect(approve).toMatchObject({ shows: ['rootCause', 'rulings', 'files', 'plan'] });
  });

  it('gives up after maxAttempts failing patches', () => {
    const { r, ran, state, end } = play({
      tools: { runTests: () => tests(false), captureDiff: freshDiff() },
    });
    expect(r.state.outcome).toBe('failed');
    expect(end).toBe('gaveUp');
    expect(ran('apply')).toBe(3);
    expect(state.attempts).toBe(3);
  });

  it('a wrong diagnosis goes back to research with the failure, once, and is approved again', () => {
    let verdicts = 0;
    const { r, ran, state, end } = play({
      agents: {
        triage: () => ({
          updates: {
            failureKind: verdicts++ === 0 ? 'DIAGNOSIS' : 'PATCH',
            failureReason: 'the bug is in the caller',
          },
          verdict: v,
        }),
      },
      tools: {
        captureDiff: freshDiff(),
        runTests: (s) => tests((s.diagnoses as number) === 1 && (s.attempts as number) >= 1),
      },
    });
    expect(r.state.outcome).toBe('success');
    expect(end).toBe('fixed');
    expect(state.diagnoses).toBe(1);
    expect(ran('research')).toBe(2);
    expect(ran('diagnose')).toBe(2);
    expect(ran('approve')).toBe(2);
    const second = r.state.steps.filter((s) => s.nodeId === 'research')[1]!;
    expect(second.input?.gaps).toEqual(['the bug is in the caller']);
  });

  it('an identical or empty patch is no progress: re-diagnose instead of spending attempts', () => {
    const { r, ran, state, end } = play({
      tools: { captureDiff: () => ({ diff: 'same', hash: 'same', files: ['src/paginate.ts'] }) },
    });
    // Attempt 1 runs the tests; every repeat (even after re-diagnosis) is caught before them.
    expect(ran('runTests')).toBe(1);
    expect(state.failureKind).toBe('NO_PROGRESS');
    expect(state.failureReason).toBe('the edit is identical to an earlier attempt');
    expect(r.state.outcome).toBe('failed');
    expect(end).toBe('gaveUp');
    expect(ran('diagnose')).toBe(2);
    const empty = play({ tools: { captureDiff: () => ({ diff: '', hash: 'e', files: [] }) } });
    expect(empty.ran('runTests')).toBe(0);
    expect(empty.state.failureReason).toBe('the edit changed no files');
  });

  it('an edit back to the starting workspace, or to an earlier attempt (A→B→A), is no progress', () => {
    // A dirty workspace: the snapshot already has changes; the edit undoes its own work.
    const back = play({
      tools: {
        snapshot: () => ({ diff: 'dirty', hash: 'start', files: ['src/paginate.ts'] }),
        captureDiff: () => ({ diff: 'dirty', hash: 'start', files: ['src/paginate.ts'] }),
        runTests: () => tests(true),
      },
    });
    expect(back.ran('runTests')).toBe(0);
    expect(back.state.failureReason).toBe('the edit left the workspace as it was before any edit');
    expect(back.r.state.outcome).not.toBe('success');
    // A, B, then A again: the third attempt is caught before the tests run.
    const seq = ['A', 'B', 'A'];
    let n = 0;
    const cycle = play({
      tools: {
        captureDiff: () => {
          const h = seq[Math.min(n++, seq.length - 1)]!;
          return { diff: h, hash: h, files: ['src/paginate.ts'] };
        },
        runTests: () => tests(false),
      },
    });
    expect(cycle.ran('runTests')).toBe(2);
    expect(cycle.state.triedHashes).toEqual(['A', 'B']);
    expect(cycle.state.failureReason).toBe('the edit is identical to an earlier attempt');
  });

  it('runs the tests before any edit, and every later run uses the command that one ran', () => {
    const { r, state } = play({
      tools: {
        baseline: () => ({ passed: false, output: 'FAIL page 2', command: 'npx vitest run' }),
        captureDiff: freshDiff(),
      },
    });
    expect(state.baselineOutput).toBe('FAIL page 2');
    // An edit to package.json's test script cannot change what verifies the fix.
    expect(state.testCommand).toBe('npx vitest run');
    const runs = r.state.steps.filter((x) => x.nodeId === 'runTests');
    expect(runs.length).toBeGreaterThan(0);
    const node = compileScore(fix, { context: demo.context! }).nodes.find(
      (n) => n.id === 'runTests',
    );
    expect(node).toMatchObject({ inputs: { command: 'testCommand', timeoutMs: 'testTimeoutMs' } });
  });

  it('research and the debate read the findings brief; only the diagnosis reads them in full', () => {
    const score = compileScore(fix, { context: demo.context! });
    const reads = (id: string) => {
      const n = score.nodes.find((x) => x.id === id);
      return n?.kind === 'agent' ? n.reads : [];
    };
    expect(reads('research')).toContain('findingsBrief');
    expect(reads('research')).not.toContain('findings');
    expect(reads('challenge')).toContain('findingsBrief');
    expect(reads('challenge')).not.toContain('findings');
    expect(reads('diagnose')).toContain('findings');
  });

  it('reproduceFirst (opt-in): the bug is reproduced by a locked, red test before the fix', () => {
    const reproducing = {
      agents: {
        planReproduce: () => ({
          updates: {
            acceptanceCriteria: ['C1: page 2 starts after the last item of page 1'],
            testsToAdd: ['src/paginate.test.ts: page 2 of [1..20] by 10 starts at 11'],
          },
          verdict: v,
        }),
        writeTests: () => ({ updates: { testFiles: ['src/paginate.test.ts'] }, verdict: v }),
        checkRed: () => ({
          updates: { redReport: ['C1: RED — page 2 starts at 10 — the bug'], wrongRed: [] },
          verdict: v,
        }),
      },
      tools: {
        captureTests: () => ({ diff: '+test', hash: 'tests-1', files: ['src/paginate.test.ts'] }),
        runRed: () => tests(false, 'FAIL page 2 starts at 10'),
        lockTests: () => ({ diff: '', hash: 'locked', files: ['src/paginate.test.ts'] }),
        checkTests: () => ({ diff: '', hash: 'locked', files: ['src/paginate.test.ts'] }),
      },
    };
    const on = play(reproducing, { reproduceFirst: true });
    expect(on.r.state.outcome).toBe('success');
    const order = on.r.state.steps.map((x) => x.nodeId);
    for (const [a, b] of [
      ['approve', 'planReproduce'],
      ['planReproduce', 'writeTests'],
      ['lockTests', 'apply'],
      ['checkTests', 'prReview'],
    ])
      expect(order.indexOf(a!), `${a} before ${b}`).toBeLessThan(order.indexOf(b!));
    // The edit has to change more than the tests.
    expect(on.state.baseDiffHash).toBe('tests-1');
    // Off (the default): none of it plays.
    const off = play(reproducing);
    expect(off.r.state.steps.map((x) => x.nodeId)).not.toContain('planReproduce');
    expect(off.r.state.outcome).toBe('success');
  });

  it('research may split its hypotheses across sub-agents (a trial; one call by default)', () => {
    const parts = (context: Record<string, unknown>) => {
      const r = play({}, context).r;
      return r.state.events.flatMap((e) =>
        e.type === 'paused' && e.pause.kind === 'agent' && e.pause.nodeId === 'research'
          ? [e.pause.parts?.map((p) => p.hypotheses) ?? []]
          : [],
      )[0]!;
    };
    expect(parts({})).toEqual([]);
    const split = parts({ hypothesesPerResearch: 1 });
    expect(split.length).toBeGreaterThan(1);
    expect(split.every((h) => (h as string[]).length === 1)).toBe(true);
  });

  it('lists changed files that configure the checks, for the reviewer', () => {
    let n = 0;
    const { state } = play({
      tools: {
        captureDiff: () => ({
          diff: `p${++n}`,
          hash: `h${n}`,
          files: [
            'package.json',
            'src/paginate.ts',
            'vitest.config.ts',
            '.github/workflows/ci.yml',
          ],
        }),
      },
    });
    expect(state.checkFiles).toEqual([
      'package.json',
      'vitest.config.ts',
      '.github/workflows/ci.yml',
    ]);
  });

  it('an environmental failure runs the same patch once more, then stops: another edit cannot fix it', () => {
    const environmental = {
      triage: () => ({
        updates: { failureKind: 'ENVIRONMENT', failureReason: 'npm ERR! network ETIMEDOUT' },
        verdict: v,
      }),
    };
    const lasting = play({ agents: environmental, tools: { runTests: () => tests(false) } });
    expect(lasting.r.state.outcome).toBe('failed');
    expect(lasting.end).toBe('gaveUp');
    expect(lasting.ran('apply')).toBe(1);
    expect(lasting.ran('runTests')).toBe(2);
    expect(lasting.state.failureKind).toBe('ENVIRONMENT');
    // A flaky failure: the second run of the same patch passes.
    let n = 0;
    const flaky = play({ agents: environmental, tools: { runTests: () => tests(n++ > 0) } });
    expect(flaky.r.state.outcome).toBe('success');
    expect(flaky.ran('apply')).toBe(1);
  });

  it('lint runs only once the tests pass; one edit budget holds across diagnoses and review rounds', () => {
    const { r, ran, state } = play(
      { tools: { captureDiff: freshDiff(), runTests: () => tests(false) } },
      { lintCommand: 'npm run lint', maxEdits: 2, maxAttempts: 5 },
    );
    expect(ran('runLint')).toBe(0);
    expect(state.lintOutput).toBe('not run: the tests failed first');
    // Five attempts allowed per round, two edits in the run.
    expect(ran('runTests')).toBe(2);
    expect(state.edits).toBe(2);
    expect(r.state.outcome).toBe('failed');
  });

  it('runs the lint command too when given, and both must pass', () => {
    let lints = 0;
    const { r, ran, state } = play(
      {
        tools: {
          captureDiff: freshDiff(),
          runTests: () => tests(true),
          runLint: () =>
            tests(lints++ > 0, lints === 1 ? 'src/paginate.ts:3 unused variable' : 'ok'),
        },
      },
      { lintCommand: 'npm run lint' },
    );
    expect(r.state.outcome).toBe('success');
    expect(ran('runLint')).toBe(2);
    expect(state.lintPassed).toBe(true);
    const lint = r.state.steps.find((s) => s.nodeId === 'runLint')!;
    expect(lint.input).toBeUndefined();
    expect(play().ran('runLint')).toBe(0);
  });

  it('a rejected plan edits nothing', () => {
    const { r, ran, end } = play({ approvals: { approve: () => ({ approved: false }) } });
    expect(r.state.outcome).toBe('partial');
    expect(end).toBe('rejected');
    expect(ran('apply')).toBe(0);
  });

  it('the test command is a run input, never the AI', () => {
    const run = fix.nodes.find((n) => n.id === 'runTests');
    expect(run).toMatchObject({
      kind: 'tool',
      tool: 'tests.run',
      inputs: { command: 'testCommand' },
    });
    expect(fix.nodes.some((n) => n.kind === 'agent' && n.writes.includes('testCommand'))).toBe(
      false,
    );
    expect(fix.nodes.some((n) => n.kind === 'agent' && n.writes.includes('testsPassed'))).toBe(
      false,
    );
  });
});
