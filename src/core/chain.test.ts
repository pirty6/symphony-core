import { describe, expect, it } from 'vitest';
import {
  followUps,
  HANDOFF_CHARS,
  handoffContext,
  handsOnQueue,
  resultText,
  stepContext,
} from './chain.js';
import { compileScore } from './compile.js';
import { toPerformance } from './engine.js';
import { runScripted } from './scripted.js';
import type { DemoScript } from './types.js';
import { fix, investigate, refactor, review } from '../patterns/index.js';

const score = compileScore(investigate, { context: investigate.demo!.context!, generatedAt: 't' });
const performance = toPerformance(runScripted(score, investigate.demo, { at: 't' }).state);

describe('handoffContext', () => {
  it("puts the goal and the previous run's declared result into the next goal input", () => {
    const ctx = handoffContext(fix, { score, performance });
    const issue = String(ctx.issue);
    expect(issue.startsWith(score.goal)).toBe(true);
    expect(issue).toContain('## What the investigate run found');
    // Its brief for AI agents, whole; not the plain version for people.
    expect(issue).toContain('# Investigation brief for an AI agent');
    expect(issue).toContain('## Instructions for the next agent');
    expect(issue).toContain('## Evidence: the findings the answer cites');
    expect(issue).not.toContain('## In short');
    expect(() => compileScore(fix, { context: ctx })).not.toThrow();
  });

  it('given inputs win: an own goal text, and other inputs pass through', () => {
    const ctx = handoffContext(
      fix,
      { score, performance },
      { issue: 'Fix it', testCommand: 'npm test' },
    );
    expect(String(ctx.issue)).toMatch(/^Fix it\n\n## What the investigate run found/);
    expect(ctx.testCommand).toBe('npm test');
  });

  it('a brief longer than the budget is cut at its end, the least important part', () => {
    const big = {
      ...performance,
      finalState: {
        ...performance.finalState,
        handoff: `# Brief\n\n${'b'.repeat(HANDOFF_CHARS + 500)}`,
      },
    };
    const issue = String(handoffContext(fix, { score, performance: big }).issue);
    expect(issue).toContain('# Brief');
    expect(issue).toMatch(/b… \(509 more characters in the saved run\)$/);
  });

  it('hands on a bounded result: long texts and lists are cut, saying how much is left out', () => {
    // A run without a brief hands on its result, field by field.
    const fields = { ...score, result: ['answer', 'citedFindings'] };
    const big = {
      ...performance,
      finalState: {
        ...performance.finalState,
        answer: 'a'.repeat(20_000),
        citedFindings: Array.from({ length: 300 }, (_, i) => `F${i + 1} src/x.ts:${i + 1} — fact`),
      },
    };
    const issue = String(handoffContext(fix, { score: fields, performance: big }).issue);
    expect(issue.length).toBeLessThan(score.goal.length + HANDOFF_CHARS + 200);
    expect(issue).toMatch(/a… \(12000 more characters in the saved run\)/);
    expect(issue).toContain('- F40 src/x.ts:40 — fact\n- … 260 more in the saved run');
    // What a run shows as its result is not cut.
    expect(resultText(fields, big.finalState)).toContain('F300 src/x.ts:300');
  });

  it('renders only result keys, and nothing when there is no result', () => {
    expect(resultText(score, performance.finalState)).not.toContain('### findings');
    const bare = { ...score, result: undefined };
    expect(handoffContext(refactor, { score: bare, performance }).target).toBe(score.goal);
  });
});

describe('a review hands what it could not settle to investigate', () => {
  const objecting = {
    ...review.demo!,
    agents: {
      ...review.demo!.agents,
      skeptic: (s: Readonly<Record<string, unknown>>) => ({
        updates: {
          proposedDispositions: ((s.findings as string[]) ?? []).map(
            (f) => `${f.split(' ')[0]} KEEP — holds`,
          ),
          objections: ['C1 is not met: it never stops, see src/core/engine.ts:120'],
        },
        verdict: {
          outcome: 'applied' as const,
          confidence: 0.9,
          shouldTerminate: false,
          reason: 'r',
        },
      }),
    },
  };
  const played = (investigateOpen: boolean) => {
    const s = compileScore(review, {
      context: { ...review.demo!.context!, investigateOpen },
      generatedAt: 't',
    });
    return { score: s, performance: toPerformance(runScripted(s, objecting, { at: 't' }).state) };
  };

  it('only when asked (investigateOpen), and only for what is not settled', () => {
    const off = played(false);
    expect(handsOnQueue(off.score)).toBe(false);
    expect(followUps(off.score, off.performance)).toEqual([]);
    const on = played(true);
    expect(on.performance.finalState.reviewStatus).toBe('issuesOpen');
    expect(handsOnQueue(on.score)).toBe(true);
    const [step] = followUps(on.score, on.performance);
    expect(step).toMatchObject({ pattern: 'investigate' });
    const goal = (step as { goal: string }).goal;
    expect(goal).toMatch(
      /^Settle what a code review of HEAD~1\.\.HEAD left open:\n- Objections the debate could not settle: C1 is not met/,
    );
    expect(goal).toContain('## The review, as handed on');
    expect(String((step as { context: Record<string, unknown> }).context.hint)).toMatch(
      /If that is a pull request/,
    );
    // A review that settled everything hands nothing on.
    const clean = compileScore(review, {
      context: { ...review.demo!.context!, investigateOpen: true },
      generatedAt: 't',
    });
    const settled = toPerformance(runScripted(clean, review.demo, { at: 't' }).state);
    expect(settled.finalState.reviewStatus).toBe('issues');
    expect(followUps(clean, settled)).toEqual([]);
  });
});

const leftOpen = ['What is the real flake rate per package?', 'Which branch policies apply?'];
const leavingOpen: DemoScript = {
  ...investigate.demo!,
  agents: {
    ...investigate.demo!.agents,
    answer: (s, i) => {
      const base = investigate.demo!.agents!.answer!(s, i) as {
        updates: Record<string, unknown>;
      };
      return {
        updates: { ...base.updates, openQuestions: leftOpen },
        verdict: { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'r' },
      };
    },
  },
};
const investigated = (followOpen: boolean, script: DemoScript = leavingOpen) => {
  const s = compileScore(investigate, {
    context: { ...investigate.demo!.context!, followOpen },
    generatedAt: 't',
  });
  return { score: s, performance: toPerformance(runScripted(s, script, { at: 't' }).state) };
};

describe('an investigation follows up what it left open (followOpen)', () => {
  it('only when asked, with each open item and its check, and never a follow-up of its own', () => {
    const off = investigated(false);
    expect(handsOnQueue(off.score)).toBe(false);
    expect(followUps(off.score, off.performance)).toEqual([]);
    const on = investigated(true);
    expect(handsOnQueue(on.score)).toBe(true);
    const checks = on.performance.finalState.verification as string[];
    expect(checks).toHaveLength(2);
    const steps = followUps(on.score, on.performance);
    expect(steps).toHaveLength(1);
    const step = steps[0] as { pattern: string; goal: string; context: Record<string, unknown> };
    expect(step.pattern).toBe('investigate');
    expect(step.goal).toMatch(
      /^Settle what an investigation of ".+" left open:\n- What is the real flake rate/,
    );
    expect(step.goal).toContain(`- ${leftOpen[0]}\n  How to verify: ${checks[0]}`);
    expect(step.goal).toContain(`- ${leftOpen[1]}\n  How to verify: ${checks[1]}`);
    expect(step.goal).toContain('## The investigation, as handed on');
    expect(String(step.context.hint)).toMatch(/targeted experiment/);
    // The follow-up does not loop: it is not asked to follow itself up.
    expect(step.context.followOpen).toBe(false);
    const { goal, context } = stepContext(investigate, step, on);
    const next = compileScore(investigate, { goal, context });
    expect(next.initialState.question).toBe(step.goal);
    expect(handsOnQueue(next)).toBe(false);
  });

  it('nothing open: nothing handed on', () => {
    const settled = investigated(true, investigate.demo!);
    expect(settled.performance.finalState.openQuestions).toEqual([]);
    expect(followUps(settled.score, settled.performance)).toEqual([]);
  });
});
