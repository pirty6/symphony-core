import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { toPerformance } from '../core/engine.js';
import { replayPerformance } from '../core/replay.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { refactor, routePrompt } from './index.js';

const demo = refactor.demo!;

function play(over: Partial<DemoScript> = {}) {
  const script: DemoScript = {
    ...demo,
    ...over,
    agents: { ...demo.agents, ...over.agents },
    tools: { ...demo.tools, ...over.tools },
  };
  const score = compileScore(refactor, { context: demo.context!, generatedAt: 't' });
  const r = runScripted(score, script, { at: 't' });
  expect(replayPerformance(score, toPerformance(r.state)).divergence.reproduced).toBe(true);
  const ran = (id: string) => r.state.steps.filter((s) => s.nodeId === id).length;
  return { r, ran, state: r.state.state, end: r.state.cursor };
}

describe('refactor', () => {
  it('keeps behaviour: green before, green after; bugs seen are reported, not fixed', () => {
    const { r, ran, state, end } = play();
    expect(r.state.outcome).toBe('success');
    expect(end).toBe('refactored');
    expect(ran('baseline')).toBe(1);
    expect(ran('runTests')).toBe(1);
    expect(state.noticedBugs).toEqual([
      'src/paginate.ts:12 — negative page sizes are not rejected',
    ]);
    expect(refactor.result).toContain('noticedBugs');
  });

  it('will not start on red tests: nothing is planned or edited', () => {
    const { r, ran, end } = play({
      tools: { baseline: () => ({ passed: false, output: 'FAIL a.test.ts', command: 'npm test' }) },
    });
    expect(r.state.outcome).toBe('failed');
    expect(end).toBe('notGreen');
    expect(ran('plan')).toBe(0);
    expect(ran('apply')).toBe(0);
  });

  it('pre-existing changes are not progress: an edit must change the workspace', () => {
    const { r, end, state } = play({
      tools: { captureDiff: () => ({ diff: '', hash: 'base', files: ['src/old-change.ts'] }) },
    });
    expect(r.state.outcome).toBe('failed');
    expect(end).toBe('gaveUp');
    expect(state.failureKind).toBe('NO_PROGRESS');
  });

  it('retries a behaviour change with the failing test, then gives up', () => {
    let n = 0;
    const { ran, end } = play({
      tools: {
        captureDiff: () => ({ diff: `p${++n}`, hash: `h${n}`, files: ['src/paginate.ts'] }),
        runTests: () => ({ passed: false, output: 'FAIL paginate.test.ts', command: 'npm test' }),
      },
    });
    expect(end).toBe('gaveUp');
    expect(ran('apply')).toBe(3);
    expect(ran('triage')).toBe(2);
  });

  it('is what restructuring requests route to; bug reports still go to fix', () => {
    expect(routePrompt('refactor the CLI into one file per command')?.name).toBe('refactor');
    expect(routePrompt('clean up the pagination helpers')?.name).toBe('refactor');
    expect(routePrompt('fix the broken pagination')?.name).toBe('fix');
  });
});
