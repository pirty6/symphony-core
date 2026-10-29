import { describe, expect, it } from 'vitest';
import { compileScore } from '../../core/compile.js';
import { toPerformance } from '../../core/engine.js';
import { replayPerformance } from '../../core/replay.js';
import { runScripted } from '../../core/scripted.js';
import type { DemoScript, Pattern } from '../../core/types.js';
import { fix, implement, refactor } from '../index.js';

const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
const approve = () => ({
  updates: { reviewDecision: 'APPROVE', reviewComments: [], reviewSummary: 'fine' },
  verdict: v,
});
const changes = (comment: string) => ({
  updates: {
    reviewDecision: 'REQUEST_CHANGES',
    reviewComments: [comment],
    reviewSummary: 'one blocking issue',
  },
  verdict: v,
});

function play(p: Pattern, over: Partial<DemoScript>) {
  const demo = p.demo!;
  let n = 0;
  const script: DemoScript = {
    ...demo,
    agents: { ...demo.agents, ...over.agents },
    // Every edit is new and passes the tests, so only the review decides.
    tools: {
      ...demo.tools,
      captureDiff: () => ({ diff: `patch ${++n}`, hash: `h${n}`, files: ['src/a.ts'] }),
      runTests: () => ({ passed: true, output: 'ok', command: 'npm test' }),
      ...over.tools,
    },
    approvals: { ...demo.approvals, ...over.approvals },
  };
  const score = compileScore(p, { context: demo.context!, generatedAt: 't' });
  const r = runScripted(score, script, { at: 't' });
  expect(replayPerformance(score, toPerformance(r.state)).divergence.reproduced).toBe(true);
  const ran = (id: string) => r.state.steps.filter((s) => s.nodeId === id).length;
  return { r, ran, state: r.state.state, end: r.state.cursor };
}

describe('PR review after the tests pass', () => {
  it('an approving review ends the fix', () => {
    const { r, ran, end } = play(fix, { agents: { prReview: approve } });
    expect(r.state.outcome).toBe('success');
    expect(end).toBe('fixed');
    expect(ran('prReview')).toBe(1);
  });

  it('requested changes go back to editing with the comments, then the review runs again', () => {
    const { r, ran, state, end } = play(fix, {
      agents: {
        prReview: (_s, visit) =>
          visit === 0
            ? changes('BLOCKING src/a.ts:3 — the test passes without the fix')
            : approve(),
      },
    });
    expect(end).toBe('fixed');
    expect(ran('prReview')).toBe(2);
    expect(ran('apply')).toBe(2);
    expect(ran('runTests')).toBe(2);
    expect(state.reviewRounds).toBe(1);
    // The second edit saw the reviewer's comment.
    const second = r.state.steps.filter((s) => s.nodeId === 'apply')[1]!;
    expect(second.input?.reviewComments).toEqual([
      'BLOCKING src/a.ts:3 — the test passes without the fix',
    ]);
    expect(second.input?.failureReason).toMatch(/PR review requested changes/);
  });

  it('never approved: after the last round a person accepts the change, or stops it', () => {
    const never = { prReview: () => changes('BLOCKING src/a.ts:1 — still wrong') };
    const accepted = play(fix, {
      agents: never,
      approvals: { acceptAnyway: () => ({ approved: true }) },
    });
    expect(accepted.end).toBe('fixed');
    expect(accepted.ran('prReview')).toBe(3);
    expect(accepted.state.reviewComments).toEqual(['BLOCKING src/a.ts:1 — still wrong']);

    const stopped = play(fix, {
      agents: never,
      approvals: { acceptAnyway: () => ({ approved: false }) },
    });
    expect(stopped.r.state.outcome).toBe('partial');
    expect(stopped.end).toBe('reviewStopped');
  });

  it('refactor and implement are reviewed too (implement after its acceptance review)', () => {
    const r = play(refactor, { agents: { prReview: approve } });
    expect(r.end).toBe('refactored');
    expect(r.ran('prReview')).toBe(1);
    const i = play(implement, { agents: { prReview: approve } });
    expect(i.end).toBe('implemented');
    const order = i.r.state.steps.map((s) => s.nodeId);
    expect(order.lastIndexOf('prReview')).toBeGreaterThan(order.lastIndexOf('review'));
  });
});
