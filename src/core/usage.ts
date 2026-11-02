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

/**
 * Wall time per node, in ms: each AI answer from its transcript's start to end (rejected
 * attempts included; a fanned-out step from its first part's start to its last part's end).
 */
export function wallTimeByNode(perf: Pick<Performance, 'steps'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of perf.steps)
    for (const t of [...(s.attempts ?? []).map((a) => a.transcript), s.transcript]) {
      const span = spanOf(t);
      if (span) out[s.nodeId] = (out[s.nodeId] ?? 0) + (span[1] - span[0]);
    }
  return out;
}

/**
 * When an answer ran: its own start and end, or (a fanned-out step recorded before the step
 * kept its own clock) its first part's start to its last part's end.
 */
function spanOf(t: AiTranscript | undefined): [number, number] | undefined {
  if (!t) return undefined;
  const from = Date.parse(t.startedAt ?? '');
  const to = Date.parse(t.completedAt ?? '');
  if (Number.isFinite(from) && Number.isFinite(to) && to >= from) return [from, to];
  const spans = (t.parts ?? []).map(spanOf).filter((x): x is [number, number] => x !== undefined);
  if (spans.length === 0) return undefined;
  return [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))];
}

/** One step's part of a run: tokens over every visit (parts and rejected answers included) and wall time. */
export interface StepShare {
  readonly node: string;
  readonly usage: TokenUsage;
  readonly ms: number;
  /** Shares of the run's input tokens and of its summed AI wall time, 0..1. */
  readonly inputShare: number;
  readonly timeShare: number;
}

/** Every AI step's share of a run's input and wall time, most input first. */
export function stepShares(perf: Pick<Performance, 'steps'>): StepShare[] {
  const { total, byNode } = performanceUsage(perf);
  const ms = wallTimeByNode(perf);
  const allMs = Object.values(ms).reduce((a, x) => a + x, 0);
  const nodes = [...new Set([...Object.keys(byNode), ...Object.keys(ms)])];
  return nodes
    .map((node) => {
      const usage = byNode[node] ?? NO_USAGE;
      return {
        node,
        usage,
        ms: ms[node] ?? 0,
        inputShare: total.inputTokens ? usage.inputTokens / total.inputTokens : 0,
        timeShare: allMs ? (ms[node] ?? 0) / allMs : 0,
      };
    })
    .toSorted((x, y) => y.usage.inputTokens - x.usage.inputTokens || y.ms - x.ms);
}

export interface FirstCalls {
  /** Sessions (parts, attempts) with a recorded first call. */
  readonly sessions: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * Per node: what each session's FIRST model call read from the cache. Every part of a
 * fanned-out step is its own session, so this says whether the shared prompt prefix was
 * reused across parts (later calls of a session reuse its own history either way).
 */
export function firstCallCache(perf: Pick<Performance, 'steps'>): Record<string, FirstCalls> {
  const out: Record<string, FirstCalls> = {};
  for (const s of perf.steps)
    for (const t of [...(s.attempts ?? []).map((a) => a.transcript), s.transcript]) {
      for (const session of t?.parts ?? (t ? [t] : [])) {
        const first = session.calls?.[0];
        if (!first) continue;
        const was = out[s.nodeId] ?? { sessions: 0, inputTokens: 0, cacheReadTokens: 0 };
        out[s.nodeId] = {
          sessions: was.sessions + 1,
          inputTokens: was.inputTokens + first.inputTokens,
          cacheReadTokens: was.cacheReadTokens + first.cacheReadTokens,
        };
      }
    }
  return out;
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
/** Per node visited more than once: last visit's input over the first's (2 = it doubled). */
export function growthRatios(byVisit: readonly VisitUsage[]): Record<string, number> {
  const per = new Map<string, number[]>();
  for (const v of byVisit) per.set(v.nodeId, [...(per.get(v.nodeId) ?? []), v.usage.inputTokens]);
  return Object.fromEntries(
    [...per]
      .filter(([, ins]) => ins.length > 1 && ins[0]! > 0)
      .map(([id, ins]) => [id, +(ins.at(-1)! / ins[0]!).toFixed(2)]),
  );
}

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

/**
 * Why answers were thrown away, by "<step>: <reason>" and how often. Quoted text and numbers
 * are folded ("…", N) so the same check failing on different values counts as one reason.
 */
export function rejectionReasons(perf: Pick<Performance, 'steps'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of perf.steps)
    for (const a of s.attempts ?? [])
      for (const e of a.errors) {
        const reason = e
          .replace(/"[^"]*"/g, '"…"')
          .replace(/[0-9]+/g, 'N')
          .slice(0, 160);
        const key = `${s.nodeId}: ${reason}`;
        out[key] = (out[key] ?? 0) + 1;
      }
  return out;
}

const RATE_LIMIT = /\b429\b|rate.?limit|too many requests/i;

/** A transcript with its parallel parts and takes, flattened. */
const everyTranscript = (t: AiTranscript | undefined): AiTranscript[] =>
  t
    ? [t, ...(t.parts ?? []).flatMap(everyTranscript), ...(t.takes ?? []).flatMap(everyTranscript)]
    : [];

const stepTranscripts = (s: Performance['steps'][number]): AiTranscript[] =>
  [s.transcript, ...(s.attempts ?? []).map((a) => a.transcript)].flatMap(everyTranscript);

/**
 * Rate limits a run hit: model calls that failed with one (HTTP 429, "rate limit", "too many
 * requests"), and items a reader reported unreadable for one (a web page's 429).
 */
export function rateLimits(perf: Pick<Performance, 'steps'>): {
  readonly provider: number;
  readonly reads: number;
} {
  let provider = 0;
  let reads = 0;
  for (const s of perf.steps) {
    provider += stepTranscripts(s).filter(
      (t) => t.output.startsWith('provider error') && RATE_LIMIT.test(t.output),
    ).length;
    const why = s.updates?.unreadableReasons;
    if (Array.isArray(why))
      reads += why.filter((w) => typeof w === 'string' && RATE_LIMIT.test(w)).length;
  }
  return { provider, reads };
}

/** How big the saved run is (characters of JSON), and what the read record adds to it. */
export function recordSize(perf: Performance): {
  readonly run: number;
  /** The readers' notes, one per item read. */
  readonly readNotes: number;
  /** The engine's record of what it gave each step to read. */
  readonly preloaded: number;
} {
  let readNotes = 0;
  let preloaded = 0;
  for (const s of perf.steps) {
    if (Array.isArray(s.updates?.readNotes))
      readNotes += JSON.stringify(s.updates.readNotes).length;
    for (const t of stepTranscripts(s))
      if (t.preloaded) preloaded += JSON.stringify(t.preloaded).length;
  }
  return { run: JSON.stringify(perf).length, readNotes, preloaded };
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
