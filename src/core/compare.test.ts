import { describe, expect, it } from 'vitest';
import { compileScore } from './compile.js';
import { agreement, compareRuns, originOf } from './compare.js';
import { toPerformance } from './engine.js';
import { runScripted } from './scripted.js';
import type { DemoScript, Pattern, SavedRun } from './types.js';
import { hangman, investigate } from '../patterns/index.js';

function play(p: Pattern, demo: DemoScript = p.demo!, goal = 'g'): SavedRun {
  const score = compileScore(p, { goal, context: p.demo?.context ?? {}, generatedAt: 't' });
  return {
    schemaVersion: 3,
    score,
    performance: toPerformance(runScripted(score, demo, { at: 't' }).state),
  };
}

const pick = (word: string): DemoScript => ({
  ...hangman.demo!,
  agents: {
    ...hangman.demo!.agents,
    pick: (s, v) => ({ ...hangman.demo!.agents!.pick!(s, v), updates: { word } }),
  },
});

describe('compareRuns', () => {
  it('finds nothing between two performances of the same score', () => {
    expect(compareRuns(play(hangman), play(hangman))).toEqual({
      identical: true,
      differentKeys: [],
    });
  });

  it('the same outputs from different models are not called identical', () => {
    const playedBy = (model: string): SavedRun => {
      const run = play(hangman);
      const steps = run.performance.steps.map((s) =>
        s.kind === 'agent'
          ? {
              ...s,
              transcript: {
                provider: 'copilot',
                prompt: '',
                output: '',
                toolCalls: [],
                musician: {
                  tier: 2 as const,
                  requestedModel: model,
                  effort: 'high',
                  sampling: 'n/a',
                },
              },
            }
          : s,
      );
      return { ...run, performance: { ...run.performance, steps } };
    };
    expect(compareRuns(playedBy('sonnet'), playedBy('sonnet')).identical).toBe(true);
    const c = compareRuns(playedBy('sonnet'), playedBy('opus'));
    expect(c.identical).toBe(false);
    expect(c.differentKeys).toEqual([]);
    expect(c.models).toEqual({ first: ['sonnet/high'], second: ['opus/high'] });
  });

  it('blames the plan when the scores differ', () => {
    const c = compareRuns(play(hangman), play(hangman, hangman.demo, 'other goal'));
    expect(c.first).toEqual({ step: 0, cause: 'plan', detail: 'different scores: goal differ' });
  });

  it('blames the AI when an agent answered differently, and says who played', () => {
    const c = compareRuns(play(hangman), play(hangman, pick('rocket')));
    expect(c.identical).toBe(false);
    expect(c.first).toMatchObject({ nodeId: 'pick', cause: 'ai' });
    expect(c.first!.detail).toMatch(
      /^different word; played by scripted answer vs scripted answer/,
    );
    expect(c.differentKeys).toContain('word');
  });

  it('blames the environment when a tool returned something else', () => {
    const demo = investigate.demo!;
    const other: DemoScript = {
      ...demo,
      tools: {
        ...demo.tools,
        catalog: (s) => ({ ...demo.tools!.catalog!(s), names: ['web'], descriptions: ['web: x'] }),
      },
    };
    const c = compareRuns(play(investigate), play(investigate, other));
    expect(c.first).toMatchObject({ nodeId: 'catalog', cause: 'environment' });
  });
});

describe('originOf and agreement', () => {
  it('labels who played each step', () => {
    const steps = play(hangman).performance.steps;
    expect(originOf(steps.find((s) => s.nodeId === 'pick')!)).toEqual({
      origin: 'script',
      detail: 'scripted answer',
    });
    expect(originOf(steps.find((s) => s.nodeId === 'ask')!).origin).toBe('human');
    expect(originOf(steps.find((s) => s.kind === 'compute')!).origin).toBe('engine');
    const live = {
      ...steps.find((s) => s.nodeId === 'pick')!,
      transcript: {
        provider: 'copilot',
        model: 'm',
        prompt: '',
        output: '',
        toolCalls: [],
        takes: [],
      },
    };
    expect(originOf(live)).toEqual({ origin: 'live', detail: 'copilot · m' });
    expect(
      originOf({ ...live, transcript: { ...live.transcript, fromRepertoire: 'run-1' } }).origin,
    ).toBe('repertoire');
  });

  it('measures how often each step played the same output across performances', () => {
    const rows = agreement([play(hangman), play(hangman), play(hangman, pick('rocket'))]);
    expect(rows.find((r) => r.nodeId === 'pick')).toMatchObject({
      reached: 3,
      variants: 2,
      agreement: 2 / 3,
    });
    expect(rows.find((r) => r.nodeId === 'start')).toMatchObject({ variants: 1, agreement: 1 });
  });

  it('compares only the named fields, listing only the nodes that wrote them', () => {
    const runs = [play(hangman), play(hangman), play(hangman, pick('rocket'))];
    const rows = agreement(runs, ['word']);
    expect(rows.map((r) => r.nodeId)).toEqual(['pick']);
    expect(rows[0]).toMatchObject({ reached: 3, variants: 2 });
    // A field nobody disagrees on: every take agrees, whatever else differed.
    expect(agreement([runs[0]!, runs[1]!], ['word'])[0]).toMatchObject({
      variants: 1,
      agreement: 1,
    });
  });
});
