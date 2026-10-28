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
