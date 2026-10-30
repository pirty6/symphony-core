import { describe, expect, it } from 'vitest';
import { followUps } from '../core/chain.js';
import { compileScore } from '../core/compile.js';
import { toPerformance } from '../core/engine.js';
import { replayPerformance } from '../core/replay.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { MAX_BACKLOG_ITEMS } from './backlog.js';
import { backlog, routePrompt } from './index.js';

const demo = backlog.demo!;
const ITEMS = demo.agents!.extract!({}, 1).updates!.items as string[];

function play(over: Partial<DemoScript> = {}, context = demo.context!) {
  const script: DemoScript = { ...demo, ...over, agents: { ...demo.agents, ...over.agents } };
  const score = compileScore(backlog, { context, generatedAt: 't' });
  const r = runScripted(score, script, { at: 't' });
  const perf = toPerformance(r.state);
  expect(replayPerformance(score, perf).divergence.reproduced).toBe(true);
  return { r, state: r.state.state, end: r.state.cursor, steps: followUps(score, perf) };
}

const picking = (picks: unknown[]) => ({
  approvals: { choose: () => ({ approved: true, updates: { picks } }) },
});

describe('backlog', () => {
  it('queues every item when none are picked; each becomes its own run of runPattern', () => {
    const { r, end, steps } = play({}, { source: 'docs/improvements.md', testCommand: 'npm test' });
    expect(r.state.outcome).toBe('success');
    expect(end).toBe('queued');
    expect(steps).toEqual(
      ITEMS.map((goal, i) => ({
        pattern: 'implement',
        goal,
        context: {
          testCommand: 'npm test',
          // Where it comes from, and to leave the other items to their own runs.
          hint: `One item (${i + 1} of ${ITEMS.length}) of a backlog from docs/improvements.md; the others are done in their own runs, so change only what this item needs.`,
        },
      })),
    );
  });

  it('queues only the picked item numbers, in the order given', () => {
    const { state, steps } = play(picking(['2', '1']));
    expect(state.queue).toEqual([ITEMS[1], ITEMS[0]]);
    expect(steps.map((s) => (typeof s === 'string' ? s : s.goal))).toEqual([ITEMS[1], ITEMS[0]]);
  });

  it('asks again when a pick is not an item or is repeated, saying why; nothing is dropped', () => {
    const asked: unknown[][] = [];
    const answers = [['7'], ['1', '1'], ['2']];
    const { state, steps } = play({
      approvals: {
        choose: (s, visit) => {
          asked.push([s.pickProblem]);
          return { approved: true, updates: { picks: answers[visit] } };
        },
      },
    });
    expect(asked.map(([p]) => p)).toEqual([
      '',
      'Use each item number once (1 is the first item); got: 7',
      'Use each item number once (1 is the first item); got: 1, 1',
    ]);
    expect(state.queue).toEqual([ITEMS[1]]);
    expect(steps).toHaveLength(1);
  });

  it('fails without queueing when every answer stays invalid', () => {
    const { r, steps } = play(picking(['7']));
    expect(r.state.outcome).toBe('failed');
    expect(steps).toEqual([]);
  });

  it('rejecting the pick plays nothing', () => {
    const { r, steps } = play({ approvals: { choose: () => ({ approved: false }) } });
    expect(r.state.outcome).toBe('cancelled');
    expect(steps).toEqual([]);
  });

  it('ends with nothing to do when the document has no open items', () => {
    const { end, steps } = play({
      agents: {
        extract: () => ({ updates: { items: [] }, verdict: demo.agents!.extract!({}, 1).verdict }),
      },
    });
    expect(end).toBe('nothing');
    expect(steps).toEqual([]);
  });

  it('plays fix or refactor when asked, and refuses other patterns before reading anything', () => {
    expect(play({}, { source: 'x', runPattern: 'fix' }).steps[0]).toMatchObject({ pattern: 'fix' });
    const bad = play({}, { source: 'x', runPattern: 'maestro' });
    expect(bad.end).toBe('unknown');
    expect(bad.r.state.steps.some((s) => s.nodeId === 'extract')).toBe(false);
  });

  it('caps the items and is routed from improvement documents', () => {
    expect(backlog.nodes.find((n) => n.id === 'extract')).toMatchObject({
      checks: [{ expr: `len(items) <= ${MAX_BACKLOG_ITEMS}` }],
    });
    expect(routePrompt('apply the improvements in this doc')?.name).toBe('backlog');
  });
});
