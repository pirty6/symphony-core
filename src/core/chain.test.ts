import { describe, expect, it } from 'vitest';
import { handoffContext, resultText } from './chain.js';
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
    expect(issue).toContain('### answer');
    expect(issue).toContain('### rulings');
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

  it('renders only result keys, and nothing when there is no result', () => {
    expect(resultText(score, performance.finalState)).not.toContain('### findings');
    const bare = { ...score, result: undefined };
    expect(handoffContext(refactor, { score: bare, performance }).target).toBe(score.goal);
  });
});
