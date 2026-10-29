/**
 * Why do two performances differ? Pure comparison of saved runs: the first
 * divergence and its cause, where each step came from, and how much each step
 * agrees across several performances of the same score (rehearsal).
 */
import { canonicalJson } from './hash.js';
import type { ExecutableScore, PerformedStep, SavedRun } from './types.js';

/** Who played a step. */
export type Origin = 'script' | 'repertoire' | 'live' | 'tool' | 'human' | 'engine';

export interface StepOrigin {
  readonly origin: Origin;
  /** e.g. 'copilot · claude-sonnet-5 · 3 takes' or 'recorded in run 2026-…' */
  readonly detail: string;
}

export function originOf(step: PerformedStep): StepOrigin {
  if (step.kind === 'tool') return { origin: 'tool', detail: 'tool output (environment)' };
  if (step.kind === 'approval') {
    return { origin: 'human', detail: step.approval?.by ?? 'human decision' };
  }
  if (step.kind !== 'agent') return { origin: 'engine', detail: `${step.kind} (deterministic)` };
  const t = step.transcript;
  if (!t) return { origin: 'live', detail: 'AI (no transcript)' };
  if (t.fromRepertoire)
    return { origin: 'repertoire', detail: `recorded answer from ${t.fromRepertoire}` };
  if (t.provider === 'scripted') return { origin: 'script', detail: 'scripted answer' };
  const takes = t.takes?.length ? ` · ${t.takes.length} takes merged` : '';
  return { origin: 'live', detail: `${t.provider}${t.model ? ` · ${t.model}` : ''}${takes}` };
}

/** Why two performances parted ways. */
export type DivergenceCause = 'plan' | 'environment' | 'ai' | 'human' | 'engine';

export interface RunComparison {
  readonly identical: boolean;
  readonly first?: {
    readonly step: number;
    readonly nodeId?: string;
    readonly cause: DivergenceCause;
    readonly detail: string;
  };
  /** Final-state keys whose values differ. */
  readonly differentKeys: readonly string[];
  /**
   * The model settings each run asked for, when they differ: identical outputs from
   * different models are a coincidence, not a reproduction.
   */
  readonly models?: { readonly first: readonly string[]; readonly second: readonly string[] };
}

/** "model/effort" each AI step asked for, in order of first use (models that answered when not recorded). */
export function modelsOf(run: SavedRun): string[] {
  const seen = new Set<string>();
  for (const s of run.performance.steps) {
    const t = s.transcript;
    if (!t || t.provider === 'scripted' || t.fromRepertoire) continue;
    const m = t.musician;
    seen.add(
      m
        ? `${m.requestedModel ?? 'default'}${m.effort ? `/${m.effort}` : ''}`
        : (t.model ?? 'default'),
    );
  }
  return [...seen];
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

const SCORE_FIELDS = [
  'pattern',
  'goal',
  'context',
  'nodes',
  'edges',
  'state',
  'start',
  'maxSteps',
  'complexity',
  'improvisation',
] as const satisfies readonly (keyof ExecutableScore)[];

const CAUSE_BY_KIND: Partial<Record<PerformedStep['kind'], DivergenceCause>> = {
  agent: 'ai',
  tool: 'environment',
  approval: 'human',
};

function playedBy(s: PerformedStep): string {
  const o = originOf(s);
  return o.detail;
}

export function compareRuns(a: SavedRun, b: SavedRun): RunComparison {
  const fa = a.performance.finalState;
  const fb = b.performance.finalState;
  const differentKeys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
    .filter((k) => !same(fa[k], fb[k]))
    .toSorted();
  const ma = modelsOf(a);
  const mb = modelsOf(b);
  const models = same(ma.toSorted(), mb.toSorted()) ? undefined : { first: ma, second: mb };
  const result = (first?: RunComparison['first']): RunComparison => ({
    identical:
      first === undefined &&
      differentKeys.length === 0 &&
      a.performance.outcome === b.performance.outcome &&
      models === undefined,
    ...(first ? { first } : {}),
    differentKeys,
    ...(models ? { models } : {}),
  });

  if (a.score.id !== b.score.id) {
    const fields = SCORE_FIELDS.filter((f) => !same(a.score[f], b.score[f]));
    return result({
      step: 0,
      cause: 'plan',
      detail: `different scores: ${fields.length > 0 ? fields.join(', ') : 'id'} differ`,
    });
  }

  const sa = a.performance.steps;
  const sb = b.performance.steps;
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (!x || !y) {
      const shorter = x ? b.performance : a.performance;
      return result({
        step: (x ?? y)!.step,
        cause: shorter.outcome === 'cancelled' ? 'human' : 'environment',
        detail: `one run stopped earlier: ${shorter.outcome}${shorter.reason ? ` (${shorter.reason})` : ''}`,
      });
    }
    if (x.nodeId !== y.nodeId) {
      return result({
        step: x.step,
        cause: 'engine',
        detail: `same state led to different nodes (${x.nodeId} vs ${y.nodeId}): the engine changed`,
      });
    }
    if (x.stateHashBefore !== y.stateHashBefore) {
      return result({
        step: x.step,
        nodeId: x.nodeId,
        cause: 'environment',
        detail: 'same state but a different workspace fingerprint before this step',
      });
    }
    if (x.stateHashAfter === y.stateHashAfter && x.next === y.next) continue;
    const keys = [...new Set([...x.changes, ...y.changes].map((c) => c.key))].toSorted();
    const cause = CAUSE_BY_KIND[x.kind] ?? 'engine';
    const what =
      keys.length > 0 ? `different ${keys.join(', ')}` : `different route (${x.next} vs ${y.next})`;
    const who =
      cause === 'ai'
        ? `; played by ${playedBy(x)} vs ${playedBy(y)}`
        : cause === 'engine'
          ? '; the engine changed'
          : '';
    return result({ step: x.step, nodeId: x.nodeId, cause, detail: `${what}${who}` });
  }
  return result();
}

export interface NodeAgreement {
  readonly nodeId: string;
  readonly kind: PerformedStep['kind'];
  /** Performances that reached this node. */
  readonly reached: number;
  /** Distinct outputs (all its visits together) among those performances. */
  readonly variants: number;
  /** Share of performances that played the most common output, 0..1. */
  readonly agreement: number;
}

/**
 * Per node, how often several performances of one score produced the same output.
 * With `fields`, only those state fields count (e.g. a router's `chosen` and `complexity`,
 * not its free-text reason), and only nodes that wrote one of them are listed.
 */
export function agreement(runs: readonly SavedRun[], fields?: readonly string[]): NodeAgreement[] {
  const only = fields && fields.length > 0 ? new Set(fields) : undefined;
  const writers = new Set<string>();
  const order: string[] = [];
  const kinds = new Map<string, PerformedStep['kind']>();
  const outputs = new Map<string, string[]>();
  for (const run of runs) {
    const perNode = new Map<string, unknown[]>();
    for (const s of run.performance.steps) {
      if (!kinds.has(s.nodeId)) {
        kinds.set(s.nodeId, s.kind);
        order.push(s.nodeId);
      }
      const changes = only ? s.changes.filter((c) => only.has(c.key)) : s.changes;
      if (changes.length > 0) writers.add(s.nodeId);
      const out = changes.map((c) => [c.key, c.after]);
      // With fields, where a node went next is not what is being compared.
      const visit = only ? { out } : { out, next: s.next ?? null };
      perNode.set(s.nodeId, [...(perNode.get(s.nodeId) ?? []), visit]);
    }
    for (const [id, visits] of perNode)
      outputs.set(id, [...(outputs.get(id) ?? []), canonicalJson(visits)]);
  }
  return order
    .filter((nodeId) => !only || writers.has(nodeId))
    .map((nodeId) => {
      const outs = outputs.get(nodeId) ?? [];
      const counts = new Map<string, number>();
      for (const o of outs) counts.set(o, (counts.get(o) ?? 0) + 1);
      const top = Math.max(0, ...counts.values());
      return {
        nodeId,
        kind: kinds.get(nodeId)!,
        reached: outs.length,
        variants: counts.size,
        agreement: outs.length > 0 ? top / outs.length : 0,
      };
    });
}
