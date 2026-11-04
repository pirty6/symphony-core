import { describe, expect, it } from 'vitest';
import { HANDOFF_CHARS, handoffContext, resultText } from './chain.js';
import { compileScore } from './compile.js';
import { toPerformance } from './engine.js';
import { runScripted } from './scripted.js';
import { fix, investigate, refactor } from '../patterns/index.js';

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
