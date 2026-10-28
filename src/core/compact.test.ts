import { describe, expect, it } from 'vitest';
import { investigate } from '../patterns/index.js';
import { compactPerformance, expandPerformance } from './compact.js';
import { compileScore } from './compile.js';
import { toPerformance } from './engine.js';
import { replayPerformance } from './replay.js';
import { runScripted } from './scripted.js';
import type { Performance } from './types.js';

const score = compileScore(investigate, {
  goal: investigate.demo!.goal!,
  context: investigate.demo!.context!,
  generatedAt: 't',
});
const played = toPerformance(runScripted(score, investigate.demo, { at: 't' }).state);
// A real run carries what the AI saw and said; the demo has none, so add some.
const transcript = {
  provider: 'copilot',
  model: 'm',
  prompt: 'p'.repeat(2000),
  output: 'o'.repeat(2000),
  toolCalls: [{ name: 'view', args: { path: 'a' } }],
  usage: { calls: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 },
};
const perf: Performance = {
  ...played,
  provider: 'copilot',
  steps: played.steps.map((s) => (s.kind === 'agent' ? Object.assign({}, s, { transcript }) : s)),
};
const size = (p: Performance) => JSON.stringify(p).length;

describe('compacting old runs', () => {
  const compact = compactPerformance(score, perf)!;

  it('drops the rebuildable history and the AI text, keeping answers, hashes and identity', () => {
    expect(compact.compacted).toBe(true);
    expect(compact.events).toEqual([]);
    expect(size(compact)).toBeLessThan(size(perf) / 3);
    const agent = compact.steps.find((s) => s.kind === 'agent')!;
    expect(agent.transcript).toEqual({
      provider: 'copilot',
      model: 'm',
      prompt: '',
      output: '',
      toolCalls: [],
      usage: { calls: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 },
    });
    expect(compact.steps.map((s) => [s.moveKey, s.stateHashAfter, s.updates])).toEqual(
      perf.steps.map((s) => [s.moveKey, s.stateHashAfter, s.updates]),
    );
  });

  it('still replays exactly, and loading rebuilds the timeline', () => {
    expect(replayPerformance(score, compact).divergence.reproduced).toBe(true);
    const back = expandPerformance(score, compact);
    expect(back.events).toEqual(perf.events);
    expect(back.steps.map((s) => [s.changes, s.input])).toEqual(
      perf.steps.map((s) => [s.changes, s.input]),
    );
    expect(back.compacted).toBe(true);
  });

  it('refuses a run that no longer replays, and leaves full runs alone', () => {
    const tampered = { ...perf, steps: perf.steps.map((s) => ({ ...s, stateHashAfter: 'x' })) };
    expect(compactPerformance(score, tampered)).toBeUndefined();
    expect(compactPerformance(score, compact)).toBe(compact);
    expect(expandPerformance(score, perf)).toBe(perf);
  });
});
