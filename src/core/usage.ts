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

export function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** One answer's usage, including the jazz takes merged into it. */
export function transcriptUsage(t: AiTranscript | undefined): TokenUsage {
  if (!t || t.fromRepertoire) return NO_USAGE;
  return (t.takes ?? []).reduce(
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

const k = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** e.g. "1.2M in (800k cached) · 45k out · 37 calls" */
export function formatUsage(u: TokenUsage): string {
  if (u.calls === 0) return 'no AI tokens';
  return `${k(u.inputTokens)} in${u.cacheReadTokens ? ` (${k(u.cacheReadTokens)} cached)` : ''} · ${k(u.outputTokens)} out · ${u.calls} calls`;
}
