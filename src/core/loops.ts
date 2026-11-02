/**
 * Every loop must be bounded by something the engine enforces: a node's visit cap
 * (maxVisits, visitsFrom), or a condition that compares a counter the loop increments
 * with a max* field ("gapRounds < maxGapRounds"). maxSteps and the refusal to repeat a
 * state stop anything else, so an unbounded loop is a warning, not an error.
 */
import type { PatternGraph, ScoreNode } from './types.js';

/** Strongly connected components with a cycle (several nodes, or one with an edge to itself). */
export function cycles(
  ids: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
): string[][] {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from)!.push(e.to);
  // Tarjan's algorithm, iterative so a long chain cannot overflow the stack.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let next = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work.at(-1)!;
      const succ = out.get(top.id)!;
      if (top.i < succ.length) {
        const w = succ[top.i++]!;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          work.push({ id: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.id, Math.min(low.get(top.id)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(top.id)!));
      if (low.get(top.id) !== index.get(top.id)) continue;
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== top.id);
      if (comp.length > 1 || out.get(top.id)!.includes(top.id)) found.push(comp.toReversed());
    }
  }
  return found;
}

const COMPARE = /([A-Za-z_]\w*)\s*(?:<=?|>=?)\s*(max\w*)|(max\w*)\s*(?:<=?|>=?)\s*([A-Za-z_]\w*)/g;

/** The fields a condition compares with a max* field: candidate loop counters. */
function guardedCounters(expression: string): string[] {
  return [...expression.matchAll(COMPARE)].map((m) => m[1] ?? m[4]!);
}

/** Does a compute node in the loop increment this counter ("x + 1")? */
function increments(nodes: readonly ScoreNode[], counter: string): boolean {
  const plus = new RegExp(`(^|[^\\w])${counter}\\s*\\+`);
  return nodes.some(
    (n) => n.kind === 'compute' && n.assign.some((a) => a.field === counter && plus.test(a.expr)),
  );
}

const capped = (n: ScoreNode) => n.maxVisits !== undefined || n.visitsFrom !== undefined;

/** Loops nothing bounds, each as the ids of its nodes. */
export function unboundedLoops(g: PatternGraph): string[][] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const open = (ids: readonly string[]): string[][] =>
    cycles(ids, g.edges).flatMap((comp) => {
      const members = comp.map((id) => byId.get(id)!);
      const guard = members.find(
        (n) =>
          n.kind === 'condition' &&
          guardedCounters(n.expression).some((c) => increments(members, c)),
      );
      // A guarded component may still hold another cycle that avoids the guard.
      return guard ? open(comp.filter((id) => id !== guard.id)) : [comp];
    });
  return open(g.nodes.filter((n) => !capped(n)).map((n) => n.id));
}
