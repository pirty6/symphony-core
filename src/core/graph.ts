/**
 * Pattern <-> visual graph conversion and a deterministic layered layout.
 * Pure, framework-free shapes that map 1:1 onto React Flow nodes/edges.
 */
import type { Branch, NodeKind, PatternGraph, ScoreEdge, ScoreNode } from './types.js';

export interface VisualNode {
  readonly id: string;
  readonly type: NodeKind;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: {
    readonly node: ScoreNode;
    readonly reads: readonly string[];
    readonly writes: readonly string[];
  };
}

export interface VisualEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: Branch;
  readonly label?: string;
  readonly data: {
    readonly edge: ScoreEdge;
    /** Keys the source node writes: the data travelling on this edge. */
    readonly carries: readonly string[];
    readonly back: boolean;
  };
}

export interface VisualGraph {
  readonly nodes: VisualNode[];
  readonly edges: VisualEdge[];
}

export const LAYOUT = { rowGap: 150, colGap: 260 } as const;

export function readsOf(node: ScoreNode): string[] {
  return node.kind === 'agent' ? [...node.reads] : [];
}

export function writesOf(node: ScoreNode, graph?: PatternGraph): string[] {
  switch (node.kind) {
    case 'agent':
    case 'approval':
      return [...node.writes];
    case 'compute':
      return [...new Set(node.assign.map((a) => a.field))];
    case 'start':
      return graph ? graph.state.map((f) => f.name) : [];
    default:
      return [];
  }
}

/** Depth of each node by BFS from start; edges into a shallower-or-equal node are back edges. */
export function depths(graph: PatternGraph): Map<string, number> {
  const depth = new Map<string, number>([[graph.start, 0]]);
  const queue = [graph.start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of graph.edges.filter((x) => x.from === id)) {
      if (!depth.has(e.to)) {
        depth.set(e.to, depth.get(id)! + 1);
        queue.push(e.to);
      }
    }
  }
  let maxDepth = Math.max(0, ...depth.values());
  for (const n of graph.nodes) if (!depth.has(n.id)) depth.set(n.id, ++maxDepth);
  return depth;
}

export function layout(graph: PatternGraph): Map<string, { x: number; y: number }> {
  const depth = depths(graph);
  const rows = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id)!;
    rows.set(d, [...(rows.get(d) ?? []), n.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of rows) {
    ids.forEach((id, i) => {
      pos.set(id, { x: (i - (ids.length - 1) / 2) * LAYOUT.colGap, y: d * LAYOUT.rowGap });
    });
  }
  return pos;
}

export function patternToGraph(
  graph: PatternGraph,
  positions?: Readonly<Record<string, { x: number; y: number }>>,
): VisualGraph {
  const auto = layout(graph);
  const depth = depths(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      position: positions?.[node.id] ?? auto.get(node.id)!,
      data: { node, reads: readsOf(node), writes: writesOf(node, graph) },
    })),
    edges: graph.edges.map((edge) => {
      const source = byId.get(edge.from);
      const label =
        edge.label ??
        edge.guard ??
        (edge.branch === 'then' || edge.branch === 'else' ? edge.branch : undefined);
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        ...(edge.branch ? { sourceHandle: edge.branch } : {}),
        ...(label ? { label } : {}),
        data: {
          edge,
          carries: source ? writesOf(source, graph) : [],
          back: (depth.get(edge.to) ?? 0) <= (depth.get(edge.from) ?? 0),
        },
      };
    }),
  };
}

/** Rebuild a pattern graph from the canvas. Guarded edges are ordered before defaults per source. */
export function graphToPattern(
  visual: {
    readonly nodes: readonly { id: string; data: { node: ScoreNode } }[];
    readonly edges: readonly VisualEdgeLike[];
  },
  base: Pick<PatternGraph, 'state' | 'maxSteps'>,
): PatternGraph {
  const nodes = visual.nodes.map((n) => ({ ...n.data.node, id: n.id }) as ScoreNode);
  const edges: ScoreEdge[] = visual.edges.map((e) => {
    const prev = e.data?.edge;
    const branch = (e.sourceHandle ?? prev?.branch) as Branch | undefined;
    return {
      id: e.id,
      from: e.source,
      to: e.target,
      ...(prev?.guard ? { guard: prev.guard } : {}),
      ...(branch ? { branch } : {}),
      ...(prev?.label ? { label: prev.label } : {}),
    };
  });
  const ordered = edges
    .map((e, i) => ({ e, i }))
    .toSorted((a, b) => {
      if (a.e.from !== b.e.from) return a.i - b.i;
      const ga = a.e.guard || a.e.branch ? 0 : 1;
      const gb = b.e.guard || b.e.branch ? 0 : 1;
      return ga - gb || a.i - b.i;
    })
    .map((x) => x.e);
  const start = nodes.find((n) => n.kind === 'start')?.id ?? '';
  return {
    state: base.state,
    nodes,
    edges: ordered,
    start,
    ...(base.maxSteps ? { maxSteps: base.maxSteps } : {}),
  };
}

export interface VisualEdgeLike {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null;
  readonly data?: { readonly edge?: ScoreEdge };
}
