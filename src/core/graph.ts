/**
 * Pattern <-> visual graph conversion and a deterministic layered layout.
 * Pure, framework-free shapes that map 1:1 onto React Flow nodes/edges.
 */
import type { Branch, NodeKind, PatternGraph, ScoreEdge, ScoreGroup, ScoreNode } from './types.js';

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

export const LAYOUT = { gap: 90, colGap: 290 } as const;

/** Rough rendered height per node kind, so rows never overlap. */
export function estimateHeight(node: ScoreNode): number {
  switch (node.kind) {
    case 'start':
    case 'end':
      return 64;
    case 'agent': {
      // Header and directive, a row per ~3 data chips in and out, checks, and the origin badge.
      const rows = Math.ceil(node.reads.length / 3) + Math.ceil(node.writes.length / 3);
      return Math.max(150, 104 + 15 * rows + (node.checks?.length ? 18 : 0) + 22);
    }
    case 'compute':
      return 64 + 17 * node.assign.length;
    case 'condition':
      return 100;
    case 'approval':
      return 120;
    case 'tool':
      return 90;
  }
}

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
    case 'tool':
      return [...new Set(Object.values(node.output))];
    case 'start':
      return graph ? graph.state.map((f) => f.name) : [];
    default:
      return [];
  }
}

/** Depth of each node by BFS from start; edges into a shallower-or-equal node are back edges. */
function reachable(
  graph: PatternGraph,
  from: string,
  blocked: string,
  reverse = false,
): Set<string> {
  const seen = new Set<string>();
  const stack = from === blocked ? [] : [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) {
      const [a, b] = reverse ? [e.to, e.from] : [e.from, e.to];
      if (a === id && b !== blocked && !seen.has(b)) stack.push(b);
    }
  }
  return seen;
}

/**
 * Loop bodies: for a condition C, the nodes entered through one of its branches
 * that only C leads into and that flow back to C. They are drawn as a row beside C.
 */
export function loopBodies(graph: PatternGraph): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  const claimed = new Set<string>();
  const ends = new Set(graph.nodes.filter((n) => n.kind === 'end').map((n) => n.id));
  for (const c of graph.nodes) {
    if (c.kind !== 'condition') continue;
    const viaStart = reachable(graph, graph.start, c.id);
    const backToC = reachable(graph, c.id, '', true);
    for (const e of graph.edges.filter((x) => x.from === c.id)) {
      const forward = reachable(graph, e.to, c.id);
      // A branch that can finish the run without coming back is the loop's exit, not its body.
      if ([...forward].some((n) => ends.has(n))) continue;
      const inside = [...forward].filter(
        (n) => !viaStart.has(n) && backToC.has(n) && !claimed.has(n),
      );
      if (inside.length === 0 || !inside.includes(e.to)) continue;
      const order: string[] = [];
      const queue = [e.to];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (order.includes(id) || !inside.includes(id)) continue;
        order.push(id);
        for (const x of graph.edges) if (x.from === id) queue.push(x.to);
      }
      order.forEach((n) => claimed.add(n));
      bodies.set(c.id, [...(bodies.get(c.id) ?? []), ...order]);
    }
  }
  return bodies;
}

export function depths(graph: PatternGraph): Map<string, number> {
  const bodies = loopBodies(graph);
  const owner = new Map<string, string>();
  for (const [c, ids] of bodies) for (const id of ids) owner.set(id, c);
  const depth = new Map<string, number>([[graph.start, 0]]);
  const queue = [graph.start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of graph.edges.filter((x) => x.from === id)) {
      if (!depth.has(e.to) && !owner.has(e.to)) {
        depth.set(e.to, depth.get(id)! + 1);
        queue.push(e.to);
      }
    }
  }
  for (const [id, c] of owner) if (depth.has(c)) depth.set(id, depth.get(c)!);
  let maxDepth = Math.max(0, ...depth.values());
  for (const n of graph.nodes) if (!depth.has(n.id)) depth.set(n.id, ++maxDepth);
  return depth;
}

export function layout(graph: PatternGraph): Map<string, { x: number; y: number }> {
  const depth = depths(graph);
  const bodies = loopBodies(graph);
  const inBody = new Set([...bodies.values()].flat());
  const rows = new Map<number, string[]>();
  for (const n of graph.nodes) {
    if (inBody.has(n.id)) continue;
    const d = depth.get(n.id)!;
    rows.set(d, [...(rows.get(d) ?? []), n.id]);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pos = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const d of [...rows.keys()].toSorted((a, b) => a - b)) {
    const ids = rows.get(d)!;
    const rowIds = [...ids];
    ids.forEach((id, i) => {
      const x = (i - (ids.length - 1) / 2) * LAYOUT.colGap;
      pos.set(id, { x, y });
      (bodies.get(id) ?? []).forEach((b, k) => {
        pos.set(b, { x: x + (k + 1) * LAYOUT.colGap, y });
        rowIds.push(b);
      });
    });
    y += Math.max(...rowIds.map((id) => estimateHeight(byId.get(id)!))) + LAYOUT.gap;
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

// ── phases (collapsible groups) ─────────────────────────────────────

export const NODE_WIDTH = 230;

export interface PhaseNode {
  readonly id: string;
  /** 'node' = a real step, 'phase' = a collapsed group. */
  readonly kind: 'node' | 'phase';
  readonly position: { readonly x: number; readonly y: number };
  readonly group?: ScoreGroup;
  /** Real node ids it stands for (one for a step, all members for a phase). */
  readonly members: readonly string[];
}

export interface PhaseEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: Branch;
  readonly label?: string;
  /** Original edge ids drawn by this edge. */
  readonly members: readonly string[];
  readonly back: boolean;
}

export interface PhaseView {
  readonly nodes: readonly PhaseNode[];
  readonly edges: readonly PhaseEdge[];
}

/** The graph with the groups not in `expanded` drawn as one node each, laid out top-down. */
export function phaseView(graph: PatternGraph, expanded: ReadonlySet<string>): PhaseView {
  const collapsed = (graph.groups ?? []).filter((g) => !expanded.has(g.id) && g.nodes.length > 0);
  const owner = new Map<string, ScoreGroup>();
  for (const g of collapsed) for (const id of g.nodes) owner.set(id, g);
  const site = (id: string) => owner.get(id)?.id ?? id;

  const nodes: ScoreNode[] = [
    ...graph.nodes.filter((n) => !owner.has(n.id)),
    ...collapsed.map(
      (g): ScoreNode => ({ id: g.id, kind: 'tool', label: g.label, tool: '', output: {} }),
    ),
  ];
  const edges: (ScoreEdge & { members: string[] })[] = [];
  for (const e of graph.edges) {
    const from = site(e.from);
    const to = site(e.to);
    if (from === to && owner.has(e.from)) continue;
    const branch = owner.has(e.from) ? undefined : e.branch;
    const same = edges.find((x) => x.from === from && x.to === to && x.branch === branch);
    if (same) {
      same.members.push(e.id);
      continue;
    }
    edges.push({
      id: e.id,
      from,
      to,
      ...(branch ? { branch } : {}),
      ...(!owner.has(e.from) && e.label ? { label: e.label } : {}),
      ...(!owner.has(e.from) && e.guard ? { guard: e.guard } : {}),
      members: [e.id],
    });
  }
  const reduced: PatternGraph = { state: graph.state, nodes, edges, start: graph.start };
  const pos = layout(reduced);
  const depth = depths(reduced);
  return {
    nodes: nodes.map((n) => {
      const g = collapsed.find((x) => x.id === n.id);
      return g
        ? { id: g.id, kind: 'phase', position: pos.get(g.id)!, group: g, members: [...g.nodes] }
        : { id: n.id, kind: 'node', position: pos.get(n.id)!, members: [n.id] };
    }),
    edges: edges.map((e): PhaseEdge => {
      const edge: { -readonly [K in keyof PhaseEdge]: PhaseEdge[K] } = {
        id: e.id,
        source: e.from,
        target: e.to,
        members: e.members,
        back: (depth.get(e.to) ?? 0) <= (depth.get(e.from) ?? 0),
      };
      const label = e.label ?? e.guard;
      if (e.branch) edge.sourceHandle = e.branch;
      if (label) edge.label = label;
      return edge;
    }),
  };
}

export interface GroupFrame {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Bounding boxes of expanded groups, so the canvas can draw a frame behind their steps. */
export function groupFrames(
  graph: PatternGraph,
  positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
  groups: readonly ScoreGroup[] = graph.groups ?? [],
  pad = 24,
): GroupFrame[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return groups.flatMap((g) => {
    const boxes = g.nodes.flatMap((id) => {
      const p = positions.get(id);
      const n = byId.get(id);
      return p && n ? [{ x: p.x, y: p.y, w: NODE_WIDTH, h: estimateHeight(n) }] : [];
    });
    if (boxes.length === 0) return [];
    const x = Math.min(...boxes.map((b) => b.x)) - pad;
    const y = Math.min(...boxes.map((b) => b.y)) - pad - 18;
    const right = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
    const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
    return [{ id: g.id, label: g.label, x, y, width: right - x, height: bottom - y }];
  });
}
