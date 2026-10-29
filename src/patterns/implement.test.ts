import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { toPerformance } from '../core/engine.js';
import { replayPerformance } from '../core/replay.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { implement } from './index.js';

const demo = implement.demo!;
const agents = demo.agents!;
const tools = demo.tools!;
const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
const tests = (passed: boolean) => ({
  passed,
  output: passed ? 'ok' : 'FAIL',
  command: 'npm test',
});
const reviewSays = (unmet: string[]) => () => ({
  updates: {
    criteriaReport: ['C1: MET — t1', unmet.length ? 'C2: NOT MET — no test' : 'C2: MET — t2'],
    unmetCriteria: unmet,
  },
  verdict: v,
});

function play(over: Partial<DemoScript> = {}, context: Record<string, unknown> = {}) {
  const script: DemoScript = {
    ...demo,
    ...over,
    agents: { ...agents, ...over.agents },
    tools: { ...tools, ...over.tools },
    approvals: { ...demo.approvals, ...over.approvals },
  };
  const score = compileScore(implement, {
    context: { ...demo.context, ...context },
    generatedAt: 't',
  });
  const r = runScripted(score, script, { at: 't' });
  const ran = (id: string) => r.state.steps.filter((s) => s.nodeId === id).length;
  expect(replayPerformance(score, toPerformance(r.state)).divergence.reproduced).toBe(true);
  return { r, ran, state: r.state.state, end: r.state.cursor };
}

describe('implement', () => {
  it('designs with acceptance criteria, edits, and an unmet criterion goes back to editing once', () => {
    const { r, ran, state, end } = play();
    expect(r.state.outcome).toBe('success');
    expect(end).toBe('implemented');
    expect(ran('baseline')).toBe(1);
    expect(ran('hypothesize')).toBe(1);
    expect(ran('design')).toBe(1);
    expect(ran('challenge')).toBe(1);
    expect(ran('apply')).toBe(2);
    expect(ran('review')).toBe(2);
    expect(state.reviews).toBe(1);
    expect(state.unmetCriteria).toEqual([]);
    expect((state.criteriaReport as string[]).length).toBe(
      (state.acceptanceCriteria as string[]).length,
    );
    expect((state.rulings as string[]).length).toBe((state.hypotheses as string[]).length);
  });

  it('shows the design and its acceptance criteria at the approval', () => {
    expect(implement.nodes.find((n) => n.id === 'approve')).toMatchObject({
      shows: ['design', 'acceptanceCriteria', 'testsToAdd', 'rulings', 'files', 'plan'],
    });
  });

  it('stops before any AI step when the tests already fail', () => {
    const { r, ran, end } = play({ tools: { baseline: () => tests(false) } });
    expect(r.state.outcome).toBe('failed');
    expect(end).toBe('notGreen');
    expect(ran('hypothesize')).toBe(0);
  });

  it('ends partial when criteria stay unmet after maxReviews', () => {
    const { r, ran, state, end } = play({ agents: { review: reviewSays(['C2: missing']) } });
    expect(r.state.outcome).toBe('partial');
    expect(end).toBe('incomplete');
    expect(ran('review')).toBe(3);
    expect(state.reviews).toBe(2);
    expect(state.unmetCriteria).toEqual(['C2: missing']);
  });

  it('passing tests are not enough: the review must account for every criterion', () => {
    const { r } = play({
      agents: {
        review: () => ({ updates: { criteriaReport: ['C1: MET'], unmetCriteria: [] }, verdict: v }),
      },
    });
    expect(r.state.outcome).not.toBe('success');
    const rejected = r.state.events.find(
      (e) => e.type === 'response-rejected' && e.nodeId === 'review',
    );
    expect(JSON.stringify(rejected)).toMatch(/one criteriaReport entry per acceptance criterion/);
  });

  it('failing tests are triaged; a wrong design goes back to exploring with the failure', () => {
    let runs = 0;
    const { ran, state, end } = play({
      tools: {
        runTests: () => tests(++runs > 1),
        captureDiff: () => ({ diff: `patch ${runs}`, hash: `h${runs}`, files: ['src/list.ts'] }),
      },
      agents: {
        triage: () => ({
          updates: { failureKind: 'DIAGNOSIS', failureReason: 'list output is cached elsewhere' },
          verdict: v,
        }),
        review: reviewSays([]),
      },
    });
    expect(end).toBe('implemented');
    expect(ran('explore')).toBe(2);
    expect(ran('design')).toBe(2);
    expect(ran('approve')).toBe(2);
    expect(state.diagnoses).toBe(1);
  });

  it('a rejected design edits nothing', () => {
    const { r, ran, end } = play({ approvals: { approve: () => ({ approved: false }) } });
    expect(r.state.outcome).toBe('partial');
    expect(end).toBe('rejected');
    expect(ran('apply')).toBe(0);
  });
});

const order = (r: ReturnType<typeof play>['r']) => r.state.steps.map((s) => s.nodeId);
const capture = (files: string[]) => () => ({ diff: 'd', hash: `h-${files.join()}`, files });

describe('implement: tests first', () => {
  it('writes the tests, sees them fail for the right reason and locks them before any code', () => {
    const { r, ran, state } = play();
    const steps = order(r);
    const first = (id: string) => steps.indexOf(id);
    expect(first('writeTests')).toBeGreaterThan(first('approve'));
    expect(first('runRed')).toBeGreaterThan(first('writeTests'));
    expect(first('checkRed')).toBeGreaterThan(first('runRed'));
    expect(first('lockTests')).toBeGreaterThan(first('checkRed'));
    expect(first('apply')).toBeGreaterThan(first('lockTests'));
    expect(ran('writeTests')).toBe(1);
    // Every green implementation is checked against the locked tests before review.
    expect(ran('checkTests')).toBe(ran('review'));
    expect(state.testsHash).toBe('locked');
    expect(state.redOutput).toMatch(/^FAIL/);
    // The implementation must change more than the tests to count as progress.
    expect(steps.filter((id) => id === 'redBase')).toHaveLength(1);
    expect(r.state.steps.find((s) => s.nodeId === 'redBase')?.changes).toContainEqual(
      expect.objectContaining({ key: 'prevDiffHash', after: 'tests-1' }),
    );
  });

  it('tests that pass before the code are written again, then a person decides', () => {
    const { ran, state, end } = play({
      tools: { runRed: () => tests(true) },
      approvals: { notRed: () => ({ approved: false }) },
    });
    expect(ran('writeTests')).toBe(3);
    expect(state.redFeedback).toMatch(/pass before any implementation/);
    expect(ran('notRed')).toBe(1);
    expect(end).toBe('testFirstStopped');
    expect(ran('apply')).toBe(0);
  });

  it('a test step that also changes code is not accepted', () => {
    let n = 0;
    const { ran, state } = play({
      tools: {
        captureTests: () =>
          capture(
            ++n === 1
              ? ['src/commands/list.test.ts', 'src/commands/list.ts']
              : ['src/commands/list.test.ts'],
          )(),
      },
    });
    expect(ran('writeTests')).toBe(2);
    expect(ran('runRed')).toBe(1);
    expect(state.redAttempts).toBe(1);
    expect(state.redFeedback).toMatch(/change only the test files/);
  });

  it('tests failing for the wrong reason are written again with the reasons', () => {
    let n = 0;
    const { ran, state } = play({
      agents: {
        checkRed: () => ({
          updates: {
            redReport: ['C1: NOT RED — syntax error', 'C2: RED — x'],
            wrongRed: ++n === 1 ? ['C1: SyntaxError in list.test.ts:4'] : [],
          },
          verdict: v,
        }),
      },
    });
    expect(ran('writeTests')).toBe(2);
    expect(ran('apply')).toBeGreaterThan(0);
    expect(state.redFeedback).toMatch(/wrong reason/);
  });

  it('an implementation that changes the locked tests stops for a person', () => {
    const { ran, end } = play({
      tools: { checkTests: () => ({ diff: '-expect(x)', hash: 'bent', files: [] }) },
      approvals: { testsChanged: () => ({ approved: false }) },
    });
    expect(ran('testsChanged')).toBe(1);
    expect(ran('review')).toBe(0);
    expect(end).toBe('testFirstStopped');
    const accepted = play({
      tools: { checkTests: () => ({ diff: '-expect(x)', hash: 'bent', files: [] }) },
    });
    expect(accepted.end).toBe('implemented');
  });
});
