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

/** Every AI answer of a run (rejected attempts included), per node and in total. */
export function performanceUsage(perf: Pick<Performance, 'steps'>): {
  readonly total: TokenUsage;
  readonly byNode: Readonly<Record<string, TokenUsage>>;
} {
  let total = NO_USAGE;
  const byNode: Record<string, TokenUsage> = {};
  for (const s of perf.steps) {
    const answers = [...(s.attempts ?? []).map((a) => a.transcript), s.transcript];
    const u = answers.reduce((sum, t) => addUsage(sum, transcriptUsage(t)), NO_USAGE);
    if (u.calls === 0) continue;
    byNode[s.nodeId] = addUsage(byNode[s.nodeId] ?? NO_USAGE, u);
    total = addUsage(total, u);
  }
  return { total, byNode };
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

/** The steps that cost most (premium requests, then input tokens), each with its usage. */
export function costliest(
  byNode: Readonly<Record<string, TokenUsage>>,
  limit = 8,
): Array<{ readonly node: string; readonly usage: TokenUsage; readonly text: string }> {
  return Object.entries(byNode)
    .toSorted(
      ([, a], [, b]) =>
        (b.premiumRequests ?? 0) - (a.premiumRequests ?? 0) || b.inputTokens - a.inputTokens,
    )
    .slice(0, limit)
    .map(([node, usage]) => ({ node, usage, text: formatUsage(usage) }));
}
