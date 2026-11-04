/**
 * Chaining patterns: one pattern's result feeds the next (investigate -> fix,
 * investigate -> refactor). Pure: it only builds the next run's inputs. Each
 * run stays its own score and performance, linked by what was handed over.
 */
import type { ExecutableScore, Pattern, Performance, PerformanceOutcome } from './types.js';

/**
 * One step of a chain: a pattern name (fed by what the previous run found) or
 * a backlog item (its own request and inputs, independent of the previous run).
 */
export type ChainStep =
  | string
  | {
      readonly pattern: string;
      readonly goal: string;
      readonly context?: Readonly<Record<string, unknown>>;
    };

export const stepPattern = (step: ChainStep): string =>
  typeof step === 'string' ? step : step.pattern;

/** Patterns whose result is a queue of runs to play next. */
export const handsOnQueue = (score: ExecutableScore): boolean => score.pattern === 'backlog';

/**
 * Steps a run puts in front of the rest of its chain: a successful backlog run
 * plays `runPattern` once per entry of `queue`, each with `testCommand` if set.
 */
export function followUps(score: ExecutableScore, performance: Performance): ChainStep[] {
  if (!handsOnQueue(score) || performance.outcome !== 'success') return [];
  const s = performance.finalState;
  const pattern = typeof s.runPattern === 'string' && s.runPattern.trim();
  if (!pattern || !Array.isArray(s.queue)) return [];
  const test = typeof s.testCommand === 'string' ? s.testCommand.trim() : '';
  const source = typeof s.source === 'string' ? s.source.trim() : '';
  const items = s.queue.filter((g): g is string => typeof g === 'string' && g.trim() !== '');
  // Each item is its own run: say where it comes from, and to leave the other items alone.
  const from = source.length <= 200 ? ` from ${source}` : '';
  return items.map((goal, i): ChainStep => {
    const hint = `One item (${i + 1} of ${items.length}) of a backlog${from}; the others are done in their own runs, so change only what this item needs.`;
    return {
      pattern,
      goal: goal.trim(),
      context: { ...(test ? { testCommand: test } : {}), hint },
    };
  });
}

/**
 * Whether a step plays after a run ended with this outcome. A chain stops when a
 * run does not succeed (the next one builds on it); backlog items are independent,
 * so they keep going after a failed item. Stopping a run stops the rest.
 */
export function playsAfter(step: ChainStep, outcome: PerformanceOutcome): boolean {
  // A partial run hands on what it has, its doubts included; the next pattern has its own gates.
  if (outcome === 'success' || outcome === 'partial') return true;
  return typeof step !== 'string' && outcome !== 'cancelled' && outcome !== 'in-progress';
}

/** How much of a result a chain hands on (the whole result stays in the saved run). */
export interface ResultLimits {
  /** Entries of a list, then a count of the rest. */
  readonly items: number;
  /** Characters of one text. */
  readonly chars: number;
}

/** What the next run of a chain gets: it reads it in every prompt, as its goal. */
export const HANDOFF_LIMITS: ResultLimits = { items: 40, chars: 8000 };
/** The whole handoff, at most. */
export const HANDOFF_CHARS = 30_000;

const cut = (text: string, chars: number) =>
  text.length > chars
    ? `${text.slice(0, chars)}… (${text.length - chars} more characters in the saved run)`
    : text;

function render(value: unknown, limits?: ResultLimits): string {
  if (typeof value === 'string') {
    const text = value.trim() || '_empty_';
    return limits ? cut(text, limits.chars) : text;
  }
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
    if (value.length === 0) return '_none_';
    const shown = limits ? value.slice(0, limits.items) : value;
    const rest = value.length - shown.length;
    return [
      ...shown.map((x) => `- ${limits ? cut(x, limits.chars) : x}`),
      ...(rest > 0 ? [`- … ${rest} more in the saved run`] : []),
    ].join('\n');
  }
  const json = `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  return limits ? cut(json, limits.chars) : json;
}

/** A run's declared result (score.result) as Markdown sections; `limits` for a chain's handoff. */
export function resultText(
  score: ExecutableScore,
  finalState: Readonly<Record<string, unknown>>,
  limits?: ResultLimits,
): string {
  return (
    (score.result ?? [])
      // An empty text says nothing (a step that was switched off): left out, as the studio does.
      .filter(
        (k) =>
          k in finalState && !(typeof finalState[k] === 'string' && !String(finalState[k]).trim()),
      )
      .map((k) => `### ${k}\n\n${render(finalState[k], limits)}`)
      .join('\n\n')
  );
}

/**
 * Inputs for the next pattern of a chain. Its goal input (goalFrom) gets the
 * goal plus what the previous run delivered; required inputs with the same name
 * and type in the previous run carry over; `given` always wins.
 */
export function handoffContext(
  next: Pattern,
  prev: { readonly score: ExecutableScore; readonly performance: Performance },
  given: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...given };
  const state = prev.performance.finalState;
  for (const name of next.requiredContext) {
    if (name in ctx || name === next.goalFrom) continue;
    const mine = next.state.find((f) => f.name === name);
    const theirs = prev.score.state.find((f) => f.name === name);
    if (mine && theirs && mine.type === theirs.type && name in state) ctx[name] = state[name];
  }
  // Your hint to the first run still applies to the next one, unless it was given its own.
  const hint = state.hint;
  if (
    !('hint' in ctx) &&
    typeof hint === 'string' &&
    hint.trim() &&
    next.state.some((f) => f.name === 'hint' && f.type === 'string')
  )
    ctx.hint = hint;
  if (next.goalFrom) {
    const own = ctx[next.goalFrom];
    const goal = typeof own === 'string' && own.trim() ? own.trim() : prev.score.goal;
    // A run that writes a brief for AI agents (its result's `handoff` text) hands on that, with
    // the whole budget: it is written for the next agent, most important first. Else its result.
    const brief = prev.score.result?.includes('handoff') ? state.handoff : undefined;
    const found =
      typeof brief === 'string' && brief.trim()
        ? cut(brief.trim(), HANDOFF_CHARS)
        : cut(resultText(prev.score, state, HANDOFF_LIMITS), HANDOFF_CHARS);
    ctx[next.goalFrom] = found
      ? `${goal}\n\n## What the ${prev.score.pattern} run found\n\n${found}`
      : goal;
  }
  return ctx;
}

/** Inputs (and goal) for the run a step starts after `prev`. */
export function stepContext(
  next: Pattern,
  step: ChainStep,
  prev: { readonly score: ExecutableScore; readonly performance: Performance },
  given: Readonly<Record<string, unknown>> = {},
): { readonly goal: string; readonly context: Record<string, unknown> } {
  if (typeof step === 'string') {
    return { goal: prev.score.goal, context: handoffContext(next, prev, given) };
  }
  const context: Record<string, unknown> = { ...step.context, ...given };
  if (next.goalFrom) context[next.goalFrom] = step.goal;
  return { goal: step.goal, context };
}
