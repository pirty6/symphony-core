/**
 * Token accounting for a performance: what the AI steps actually spent.
 * Answers replayed from the repertoire (classical) cost nothing this run.
 */
import type { AiTranscript, Performance, TokenUsage } from './types.js';

export const NO_USAGE: TokenUsage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
};

/** The optional measurements, summed only when a provider reported them. */
const EXTRA = [
  'cacheWriteTokens',
  'apiMs',
  'firstTokenMs',
  'premiumRequests',
  'nanoAiu',
  'compactions',
] as const;

export function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  const extra: Partial<Record<(typeof EXTRA)[number], number>> = {};
  for (const key of EXTRA) {
    if (a[key] !== undefined || b[key] !== undefined) extra[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    ...extra,
  };
}

/** One answer's usage, including the jazz takes or fanOut parts merged into it. */
export function transcriptUsage(t: AiTranscript | undefined): TokenUsage {
  if (!t || t.fromRepertoire) return NO_USAGE;
  return [...(t.takes ?? []), ...(t.parts ?? [])].reduce(
    (sum, take) => addUsage(sum, transcriptUsage(take)),
    addUsage(NO_USAGE, t.usage),
  );
}

/** One visit of a step: what it cost then (byNode adds every visit together). */
export interface VisitUsage {
  readonly nodeId: string;
  readonly step: number;
  readonly usage: TokenUsage;
}

/** Every AI answer of a run (rejected attempts included), per node, per visit and in total. */
export function performanceUsage(perf: Pick<Performance, 'steps'>): {
  readonly total: TokenUsage;
  readonly byNode: Readonly<Record<string, TokenUsage>>;
  readonly byVisit: readonly VisitUsage[];
} {
  let total = NO_USAGE;
  const byNode: Record<string, TokenUsage> = {};
  const byVisit: VisitUsage[] = [];
  for (const s of perf.steps) {
    const answers = [...(s.attempts ?? []).map((a) => a.transcript), s.transcript];
    const u = answers.reduce((sum, t) => addUsage(sum, transcriptUsage(t)), NO_USAGE);
    if (u.calls === 0) continue;
    byNode[s.nodeId] = addUsage(byNode[s.nodeId] ?? NO_USAGE, u);
    byVisit.push({ nodeId: s.nodeId, step: s.step, usage: u });
    total = addUsage(total, u);
  }
  return { total, byNode, byVisit };
}

/**
 * Steps visited more than once whose input grows visit by visit, worst first, as
 * "assess: 40k → 120k → 210k in": where re-sent context piles up.
 */
export function growth(byVisit: readonly VisitUsage[], n = 5): string[] {
  const per = new Map<string, number[]>();
  for (const v of byVisit) per.set(v.nodeId, [...(per.get(v.nodeId) ?? []), v.usage.inputTokens]);
  return [...per]
    .filter(([, ins]) => ins.length > 1 && ins.at(-1)! > ins[0]!)
    .toSorted(([, a], [, b]) => b.at(-1)! / Math.max(1, b[0]!) - a.at(-1)! / Math.max(1, a[0]!))
    .slice(0, n)
    .map(([id, ins]) => `${id}: ${ins.map(k).join(' → ')} in`);
}

/**
 * What rejected answers cost a run: engine-level attempts that were thrown away
 * (with their usage), and submit_result calls whose updates arrived as text
 * (each one either repaired or sent back for a correction).
 */
export function rejectionUsage(perf: Pick<Performance, 'steps'>): {
  readonly attempts: number;
  readonly attemptUsage: TokenUsage;
  readonly textUpdates: number;
} {
  let attempts = 0;
  let attemptUsage = NO_USAGE;
  let textUpdates = 0;
  for (const s of perf.steps) {
    for (const a of s.attempts ?? []) {
      attempts += 1;
      attemptUsage = addUsage(attemptUsage, transcriptUsage(a.transcript));
    }
    for (const t of [...(s.attempts ?? []).map((a) => a.transcript), s.transcript]) {
      for (const c of t?.toolCalls ?? []) {
        const args = c.args as { updates?: unknown } | undefined;
        if (c.name === 'submit_result' && typeof args?.updates === 'string') textUpdates += 1;
      }
    }
  }
  return { attempts, attemptUsage, textUpdates };
}

const k = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** e.g. "1.2M in (800k cached) · 45k out · 37 calls" */
export function formatUsage(u: TokenUsage): string {
  if (u.calls === 0) return 'no AI tokens';
  const time = u.apiMs
    ? ` · ${(u.apiMs / 1000).toFixed(1)}s in the model${u.firstTokenMs ? `, first token ${(u.firstTokenMs / u.calls / 1000).toFixed(1)}s avg` : ''}`
    : '';
  const cost = u.premiumRequests ? ` · ${+u.premiumRequests.toFixed(2)} premium requests` : '';
  const compacted = u.compactions ? ` · compacted ${u.compactions}×` : '';
  return `${k(u.inputTokens)} in${u.cacheReadTokens ? ` (${k(u.cacheReadTokens)} cached)` : ''} · ${k(u.outputTokens)} out · ${u.calls} calls${time}${cost}${compacted}`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);

/**
 * The steps that cost most (premium requests, then input tokens), each with its usage and
 * its share of the run: of the cost (premium requests, else input tokens) and of model time.
 */
export function costliest(
  byNode: Readonly<Record<string, TokenUsage>>,
  limit = 8,
): Array<{
  readonly node: string;
  readonly usage: TokenUsage;
  readonly text: string;
  /** Percent of the cost (premium requests when known, else input tokens). */
  readonly share: number;
  /** Percent of the time spent in the model, when the provider reported it. */
  readonly timeShare?: number;
}> {
  const all = Object.values(byNode);
  const premium = all.reduce((n, u) => n + (u.premiumRequests ?? 0), 0);
  const input = all.reduce((n, u) => n + u.inputTokens, 0);
  const ms = all.reduce((n, u) => n + (u.apiMs ?? 0), 0);
  return Object.entries(byNode)
    .toSorted(
      ([, a], [, b]) =>
        (b.premiumRequests ?? 0) - (a.premiumRequests ?? 0) || b.inputTokens - a.inputTokens,
    )
    .slice(0, limit)
    .map(([node, usage]) => {
      const share =
        premium > 0 ? pct(usage.premiumRequests ?? 0, premium) : pct(usage.inputTokens, input);
      const timeShare = ms > 0 ? pct(usage.apiMs ?? 0, ms) : undefined;
      const of = `${share}% of the cost${timeShare !== undefined ? `, ${timeShare}% of model time` : ''}`;
      return Object.assign(
        { node, usage, share, text: `${of}: ${formatUsage(usage)}` },
        timeShare !== undefined ? { timeShare } : {},
      );
    });
}
