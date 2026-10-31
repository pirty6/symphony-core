import { describe, expect, it } from 'vitest';
import { fix, hangman, investigate } from '../patterns/index.js';
import { compileScore } from './compile.js';
import { advance, createEngine, toPerformance } from './engine.js';
import { runScripted } from './scripted.js';
import { divergence, EMPTY_FRAME, framesOf, reduceFrame, replayPerformance } from './replay.js';
import type { Pattern } from './types.js';

function demoRun(p: Pattern) {
  const score = compileScore(p, {
    goal: p.demo?.goal ?? 'g',
    context: p.demo?.context ?? {},
    generatedAt: 't',
  });
  return { score, perf: toPerformance(runScripted(score, p.demo, { at: 't' }).state) };
}

describe('frames', () => {
  it('track active node, statuses, edge counts and state', () => {
    const { perf } = demoRun(hangman);
    const frames = framesOf(perf.events);
    const last = frames.at(-1)!;
    expect(last.outcome).toBe('success');
    expect(last.state).toEqual(perf.finalState);
    expect(last.nodeStatus.win).toBe('done');
    expect(last.edgeCounts['over-ask']).toBe(6);
    expect(last.nodeVisits.ask).toBe(7);
    const paused = frames.find((f) => f.pausedNodeId === 'pick')!;
    expect(paused.nodeStatus.pick).toBe('paused');
    const afterPick = frames.find(
      (f) => f.event?.type === 'edge-taken' && f.lastEdge?.id === 'pick-ask',
    )!;
    expect(afterPick.lastEdge?.values).toEqual({ word: 'planet' });
  });

  it('marks failures on the failing node', () => {
    const f = reduceFrame(
      reduceFrame(EMPTY_FRAME, {
        type: 'node-entered',
        step: 1,
        nodeId: 'a',
        kind: 'agent',
        stateHash: 'h',
        moveKey: 'm',
      }),
      {
        type: 'run-failed',
        error: 'boom',
        nodeId: 'a',
      },
    );
    expect(f).toMatchObject({ outcome: 'failed', error: 'boom', nodeStatus: { a: 'failed' } });
  });
});

describe('replayPerformance', () => {
  it.each([hangman, investigate, fix].map((p) => [p.name, p] as const))(
    '%s reproduces exactly',
    (_n, p) => {
      const { score, perf } = demoRun(p);
      const { result, divergence: d } = replayPerformance(score, perf);
      expect(d.reproduced).toBe(true);
      expect(result.state.events).toEqual(perf.events);
    },
  );

  it('detects tampered answers', () => {
    const { score, perf } = demoRun(fix);
    const steps = perf.steps.map((s) =>
      s.nodeId === 'runTests' && s.updates?.testsPassed === false
        ? { ...s, updates: { ...s.updates, testsPassed: true } }
        : s,
    );
    const { divergence: d } = replayPerformance(score, { ...perf, steps });
    expect(d.reproduced).toBe(false);
    expect(d.structural).toBe(true);
  });
});

describe('divergence', () => {
  it('reports semantic and environmental differences', () => {
    const { perf } = demoRun(investigate);
    const target = perf.steps.findIndex((s) => s.verdict);
    const changed = {
      ...perf,
      steps: perf.steps.map((s, i) =>
        i === target
          ? { ...s, verdict: { ...s.verdict!, outcome: 'failed' as const }, stateHashAfter: 'x' }
          : s,
      ),
    };
    const step = perf.steps[target]!.step;
    const d = divergence(perf, changed);
    expect(d.structural).toBe(false);
    expect(d.semantic).toEqual([{ step, a: 'applied', b: 'failed' }]);
    expect(d.environmental).toEqual([step]);
    expect(d.reproduced).toBe(false);
  });

  it('reproduces runs with rejected answers, both recovered and failed', () => {
    const score = compileScore(hangman, { goal: 'g', generatedAt: 't' });
    const ok = {
      updates: { word: 'cat' },
      verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
    };
    // recovered: one bad answer, then a good one, then a bad approval, then cancel
    let r = createEngine(score, { startedAt: 't' });
    r = advance(score, r.state, {
      kind: 'agent',
      pauseId: r.state.pause!.pauseId,
      result: { bogus: 1 },
      at: 't',
    });
    r = advance(score, r.state, {
      kind: 'agent',
      pauseId: r.state.pause!.pauseId,
      result: ok,
      at: 't',
    });
    r = advance(score, r.state, {
      kind: 'approval',
      pauseId: r.state.pause!.pauseId,
      approved: true,
      updates: {},
    });
    r = advance(score, r.state, {
      kind: 'approval',
      pauseId: r.state.pause!.pauseId,
      approved: true,
      updates: { letter: 'c' },
    });
    r = advance(score, r.state, {
      kind: 'cancel',
      pauseId: r.state.pause!.pauseId,
      reason: 'stop',
      at: 't',
    });
    const recovered = replayPerformance(score, toPerformance(r.state));
    expect(recovered.divergence.reproduced).toBe(true);
    expect(recovered.result.state.events).toEqual(r.state.events);
    // failed: every attempt invalid
    let f = createEngine(score, { startedAt: 't' });
    for (let i = 0; i < 3; i += 1)
      f = advance(score, f.state, {
        kind: 'agent',
        pauseId: f.state.pause!.pauseId,
        result: { bogus: i },
        at: 't',
      });
    expect(f.state.pause?.kind).toBe('stuck');
    f = advance(score, f.state, {
      kind: 'recovery',
      pauseId: f.state.pause!.pauseId,
      action: 'stop',
      at: 't',
    });
    expect(f.state.outcome).toBe('partial');
    const failed = replayPerformance(score, toPerformance(f.state));
    expect(failed.divergence.reproduced).toBe(true);
    expect(failed.result.state.events).toEqual(f.state.events);
    // Runs recorded before stuck steps existed have no decision: they replay as 'stop'.
    const old = toPerformance(f.state);
    const legacy = {
      ...old,
      steps: old.steps.map(({ recoveries: _r, ...s }) => s),
      events: old.events.filter((e) => e.type !== 'recovered'),
    };
    expect(replayPerformance(score, legacy).divergence.reproduced).toBe(true);
  });

  it('replays a stuck step that a human retried with a hint and a tier', () => {
    const score = compileScore(hangman, { goal: 'g', generatedAt: 't' });
    let r = createEngine(score, { startedAt: 't' });
    const send = (res: Record<string, unknown>) => {
      r = advance(score, r.state, { pauseId: r.state.pause!.pauseId, at: 't', ...res } as never);
    };
    for (let i = 0; i < 3; i += 1) send({ kind: 'agent', result: { bogus: i } });
    send({ kind: 'recovery', action: 'retry', hint: 'one word', complexity: 3 });
    send({ kind: 'agent', result: { bogus: 9 } });
    send({ kind: 'agent', result: { bogus: 10 } });
    send({ kind: 'agent', result: { bogus: 11 } });
    expect(r.state.pause?.kind).toBe('stuck');
    send({ kind: 'recovery', action: 'retry' });
    send({
      kind: 'agent',
      result: {
        updates: { word: 'cat' },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      },
    });
    send({ kind: 'cancel', reason: 'done here' });
    const perf = toPerformance(r.state);
    const pick = perf.steps.find((s) => s.nodeId === 'pick')!;
    expect(pick.attempts).toHaveLength(6);
    expect(pick.recoveries?.map((x) => x.action)).toEqual(['retry', 'retry']);
    const again = replayPerformance(score, perf);
    expect(again.divergence.reproduced).toBe(true);
    expect(again.result.state.events).toEqual(r.state.events);
  });

  it('replays tool results and tool failures', () => {
    const p: Pattern = {
      name: 't',
      description: 'd',
      requiredContext: [],
      state: [{ name: 'files', type: 'string[]' }],
      start: 's',
      nodes: [
        { id: 's', kind: 'start', label: 'S' },
        { id: 'list', kind: 'tool', label: 'L', tool: 'repo.files', output: { files: 'files' } },
        { id: 'e', kind: 'end', label: 'E' },
      ],
      edges: [
        { id: '1', from: 's', to: 'list' },
        { id: '2', from: 'list', to: 'e' },
      ],
    };
    const score = compileScore(p, { goal: 'g', generatedAt: 't' });
    for (const res of [
      { updates: { files: ['x'] } },
      { error: 'boom' },
      { updates: { files: 3 } },
    ]) {
      const r0 = createEngine(score, { startedAt: 't' });
      const r = advance(score, r0.state, {
        kind: 'tool',
        pauseId: r0.state.pause!.pauseId,
        ...res,
        at: 't',
      });
      const replay = replayPerformance(score, toPerformance(r.state));
      expect(replay.divergence.reproduced).toBe(true);
      expect(replay.result.state.events).toEqual(r.state.events);
    }
  });
});
