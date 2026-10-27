import { describe, expect, it } from 'vitest';
import { fix, hangman, investigate } from '../patterns/index.js';
import { graphToPattern, layout, patternToGraph } from './graph.js';
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
