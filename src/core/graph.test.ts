import { describe, expect, it } from 'vitest';
import { fix, hangman, investigate } from '../patterns/index.js';
import {
  graphToPattern,
  groupFrames,
  layout,
  loopBodies,
  patternToGraph,
  phaseView,
} from './graph.js';
import { validateGraph } from './validate.js';

describe('patternToGraph', () => {
  it('maps nodes and edges with handles, carries and back edges', () => {
    const g = patternToGraph(hangman);
    expect(g.nodes).toHaveLength(hangman.nodes.length);
    const overAsk = g.edges.find((e) => e.id === 'over-ask')!;
    expect(overAsk).toMatchObject({ source: 'over', target: 'ask', sourceHandle: 'else' });
    expect(overAsk.data.back).toBe(true);
    const pickAsk = g.edges.find((e) => e.id === 'pick-ask')!;
    expect(pickAsk.data.carries).toEqual(['word']);
    expect(pickAsk.label).toBe('word ready');
    const judge = g.nodes.find((n) => n.id === 'judge')!;
    expect(judge.data.writes).toEqual(['letter', 'guessed', 'wrongCount', 'won']);
  });

  it('lays out deterministically top-down from start', () => {
    const a = layout(fix);
    expect(a).toEqual(layout(fix));
    expect(a.get('start')!.y).toBe(0);
    expect(a.get('diagnose')!.y).toBeGreaterThan(0);
  });

  it('keeps explicit positions', () => {
    const g = patternToGraph(investigate, { plan: { x: 7, y: 9 } });
    expect(g.nodes.find((n) => n.id === 'plan')!.position).toEqual({ x: 7, y: 9 });
  });
});

describe('graphToPattern', () => {
  it('round-trips a pattern', () => {
    const back = graphToPattern(patternToGraph(fix), fix);
    expect(back.nodes).toEqual(fix.nodes);
    expect(back.edges).toEqual(fix.edges);
    expect(back.start).toBe('start');
    expect(validateGraph(back).errors).toEqual([]);
  });

  it('moves default edges after guarded ones', () => {
    const g = patternToGraph(hangman);
    const swapped = { ...g, edges: [g.edges[0]!, g.edges[2]!, g.edges[1]!, ...g.edges.slice(3)] };
    const back = graphToPattern(swapped, hangman);
    const fromPick = back.edges.filter((e) => e.from === 'pick').map((e) => e.id);
    expect(fromPick).toEqual(['pick-ask', 'pick-retry']);
  });

  it('takes branch from the canvas handle for new edges', () => {
    const g = patternToGraph(investigate);
    const edges = [
      ...g.edges.filter((e) => e.id !== 'confident-clarify'),
      { id: 'n1', source: 'confident', target: 'clarify', sourceHandle: 'else' },
    ];
    const back = graphToPattern({ nodes: g.nodes, edges }, investigate);
    expect(back.edges.find((e) => e.id === 'n1')).toEqual({
      id: 'n1',
      from: 'confident',
      to: 'clarify',
      branch: 'else',
    });
  });
});

describe('loop layout', () => {
  it('draws loop bodies as a row beside their condition', () => {
    const bodies = loopBodies(investigate);
    expect(bodies.get('filesLeft')).toEqual(['takeBatch', 'triage', 'mergeTriage']);
    expect(bodies.get('deepLeft')).toEqual(['takeDeep', 'deepRead', 'mergeDeep']);
    expect(bodies.get('sourcesLeft')).toEqual(['takeSource', 'sweep', 'mergeSource']);
    expect(bodies.get('moreGaps')).toEqual(['chase', 'mergeChase']);
    const pos = layout(investigate);
    expect(pos.get('triage')!.y).toBe(pos.get('filesLeft')!.y);
    expect(pos.get('triage')!.x).toBeGreaterThan(pos.get('filesLeft')!.x);
    expect(pos.get('deepQueue')!.y).toBeGreaterThan(pos.get('filesLeft')!.y);
  });

  it('keeps nodes reachable from start on the main path (hangman)', () => {
    expect(loopBodies(hangman).size).toBe(0);
    const g = patternToGraph(investigate);
    expect(g.edges.find((e) => e.id === 'mergeTriage-filesLeft')!.data.back).toBe(true);
  });
});

describe('phases', () => {
  it('collapses each phase into one node and keeps edges between phases', () => {
    const v = phaseView(investigate, new Set());
    const ids = v.nodes.map((n) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'start',
        'planPhase',
        'listPhase',
        'triagePhase',
        'deepPhase',
        'answer',
        'done',
      ]),
    );
    expect(ids).not.toContain('triage');
    const list = v.nodes.find((n) => n.id === 'listPhase')!;
    expect(list).toMatchObject({
      kind: 'phase',
      members: expect.arrayContaining(['inventory', 'listPages']),
    });
    expect(v.edges.find((e) => e.source === 'planPhase' && e.target === 'listPhase')).toBeDefined();
    expect(v.edges.some((e) => e.source === e.target)).toBe(false);
    const toTriage = v.edges.filter((e) => e.target === 'triagePhase');
    expect(toTriage).toHaveLength(1);
    expect(toTriage[0]!.members.length).toBeGreaterThan(1);
    expect(v.nodes.find((n) => n.id === 'deepPhase')!.position.y).toBeGreaterThan(list.position.y);
  });

  it('expands chosen phases back into their steps', () => {
    const v = phaseView(investigate, new Set(['listPhase']));
    const ids = v.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['inventory', 'listPages', 'needWeb']));
    expect(ids).not.toContain('listPhase');
    expect(ids).toContain('triagePhase');
    expect(v.edges.find((e) => e.source === 'needFiles' && e.sourceHandle === 'then')?.target).toBe(
      'inventory',
    );
  });

  it('is the full graph when there are no phases, and frames expanded phases', () => {
    expect(phaseView(fix, new Set()).nodes.map((n) => n.id)).toEqual(fix.nodes.map((n) => n.id));
    const pos = layout(investigate);
    const frames = groupFrames(investigate, pos);
    expect(frames.map((f) => f.id)).toEqual(investigate.groups!.map((g) => g.id));
    const deep = frames.find((f) => f.id === 'deepPhase')!;
    const read = pos.get('deepRead')!;
    expect(read.x).toBeGreaterThanOrEqual(deep.x);
    expect(read.y).toBeGreaterThanOrEqual(deep.y);
  });
});
