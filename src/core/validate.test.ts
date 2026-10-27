import { describe, expect, it } from 'vitest';
import type { Pattern, ScoreEdge, ScoreNode } from './types.js';
import { validateGraph, validatePattern } from './validate.js';

const base: Pattern = {
  name: 'loop-demo',
  description: 'gather until confident',
  requiredContext: ['topic'],
  state: [
    { name: 'topic', type: 'string' },
    { name: 'notes', type: 'string[]' },
    { name: 'confidence', type: 'number' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'gather',
      kind: 'agent',
      role: 'assessor',
      label: 'Gather',
      directive: 'Collect notes',
      reads: ['topic', 'notes'],
      writes: ['notes', 'confidence'],
      maxVisits: 3,
    },
    { id: 'enough', kind: 'condition', label: 'Enough?', expression: 'confidence >= 0.8' },
    { id: 'done', kind: 'end', label: 'Done' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'gather' },
    { id: 'e2', from: 'gather', to: 'enough' },
    { id: 'e3', from: 'enough', to: 'done', branch: 'then' },
    { id: 'e4', from: 'enough', to: 'gather', branch: 'else' },
  ],
};

const withNodes = (nodes: ScoreNode[], edges: ScoreEdge[] = base.edges as ScoreEdge[]) => ({
  ...base,
  nodes,
  edges,
});

const messages = (p: Pattern) =>
  validatePattern(p)
    .errors.map((e) => e.message)
    .join('\n');

describe('validatePattern', () => {
  it('accepts a valid looping pattern', () => {
    expect(validatePattern(base)).toEqual({ errors: [], warnings: [] });
  });

  it('flags condition nodes without then/else', () => {
    const edges = base.edges.filter((e) => e.id !== 'e4');
    expect(messages({ ...base, edges })).toMatch(/exactly one 'then' and one 'else'/);
  });

  it('flags unknown fields in guards, reads, writes and conditions', () => {
    const nodes = base.nodes.map((n) =>
      n.id === 'enough'
        ? { ...n, expression: 'score > 1' }
        : n.id === 'gather'
          ? { ...n, reads: ['nope'] }
          : n,
    ) as ScoreNode[];
    const m = messages(withNodes(nodes));
    expect(m).toMatch(/condition references unknown field\(s\): score/);
    expect(m).toMatch(/reads unknown state field 'nope'/);
  });

  it('flags unreachable nodes and missing ends', () => {
    const nodes = [...base.nodes, { id: 'orphan', kind: 'end', label: 'x' } as ScoreNode];
    expect(messages(withNodes(nodes))).toMatch(/'orphan' is unreachable/);
    const noEnd = withNodes(
      base.nodes.filter((n) => n.kind !== 'end'),
      base.edges.filter((e) => e.to !== 'done') as ScoreEdge[],
    );
    expect(messages(noEnd)).toMatch(/no end node is reachable/);
  });

  it('requires the default edge to be last and unique', () => {
    const edges: ScoreEdge[] = [
      { id: 'e1', from: 'start', to: 'gather' },
      { id: 'e1b', from: 'start', to: 'done', guard: 'confidence > 0.5' },
      ...base.edges.slice(1),
    ];
    expect(messages({ ...base, edges })).toMatch(/default\) edge must be declared last/);
  });

  it('rejects reserved field names, bad initial values and bad requiredContext', () => {
    const p: Pattern = {
      ...base,
      requiredContext: ['missing'],
      state: [
        ...base.state,
        { name: 'verdict', type: 'string' },
        { name: 'n', type: 'number', initial: 'x' },
      ],
    };
    const m = messages(p);
    expect(m).toMatch(/invalid state field name 'verdict'/);
    expect(m).toMatch(/'n' initial value/);
    expect(m).toMatch(/requiredContext 'missing'/);
  });

  it('allows guards on verdict', () => {
    const edges: ScoreEdge[] = [
      base.edges[0]!,
      { id: 'g1', from: 'gather', to: 'done', guard: 'verdict.outcome == "failed"' },
      ...base.edges.slice(1),
    ];
    expect(validateGraph({ ...base, edges }).errors).toEqual([]);
  });

  it('validates compute assignments', () => {
    const nodes: ScoreNode[] = [
      ...base.nodes,
      {
        id: 'calc',
        kind: 'compute',
        label: 'Calc',
        assign: [{ field: 'confidence', expr: 'len(notes) +' }],
      },
    ];
    const edges: ScoreEdge[] = [...base.edges, { id: 'c1', from: 'calc', to: 'done' }];
    const m = validateGraph({ ...base, nodes, edges })
      .errors.map((e) => e.message)
      .join('\n');
    expect(m).toMatch(/assignment to 'confidence'/);
    expect(m).toMatch(/'calc' is unreachable/);
  });

  it('validates checks and capabilities on agent nodes', () => {
    const gather = {
      ...base.nodes[1]!,
      checks: [
        { expr: 'len(nope) > 0', message: 'm' },
        { expr: 'len(notes) >', message: '' },
      ],
      capabilities: ['web', 'fax'],
    } as ScoreNode;
    const nodes = [base.nodes[0]!, gather, ...base.nodes.slice(2)];
    const m = messages(withNodes(nodes));
    expect(m).toMatch(/check references unknown field\(s\): nope/);
    expect(m).toMatch(/needs a message/);
    expect(m).toMatch(/unknown capability 'fax'/);
  });

  it('validates tool nodes', () => {
    const tool = {
      id: 'list',
      kind: 'tool',
      label: 'L',
      tool: '',
      output: { files: 'nope' },
    } as ScoreNode;
    const nodes = [...base.nodes, tool];
    const edges = [...base.edges, { id: 't1', from: 'list', to: 'done' }] as ScoreEdge[];
    const m = validateGraph({ ...base, nodes, edges })
      .errors.map((e) => e.message)
      .join('\n');
    expect(m).toMatch(/tool node needs a tool name/);
    expect(m).toMatch(/output writes unknown state field 'nope'/);
  });

  it('validates solo points and tiers', () => {
    const solo = { ...base.nodes[1]!, solo: true, complexity: 7 } as unknown as ScoreNode;
    const nodes = [base.nodes[0]!, solo, ...base.nodes.slice(2)];
    const edges: ScoreEdge[] = [
      base.edges[0]!,
      { id: 'a', from: 'gather', to: 'enough', guard: 'confidence > 0' },
      { id: 'b', from: 'gather', to: 'done' },
      ...base.edges.slice(2),
    ];
    const m = validateGraph({ ...base, nodes, edges, improvisation: 9 as 0 })
      .errors.map((e) => e.message)
      .join('\n');
    expect(m).toMatch(/solo routes cannot have guards/);
    expect(m).toMatch(/solo routes need a label/);
    expect(m).toMatch(/complexity must be 1, 2, 3 or 4/);
    expect(m).toMatch(/improvisation must be 0..4/);
  });
});
