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
  if (outcome === 'success') return true;
  return typeof step !== 'string' && outcome !== 'cancelled' && outcome !== 'in-progress';
}

function render(value: unknown): string {
  if (typeof value === 'string') return value.trim() || '_empty_';
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
    return value.length > 0 ? value.map((x) => `- ${x}`).join('\n') : '_none_';
  }
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** A run's declared result (score.result) as Markdown sections. */
export function resultText(
  score: ExecutableScore,
  finalState: Readonly<Record<string, unknown>>,
): string {
  return (score.result ?? [])
    .filter((k) => k in finalState)
    .map((k) => `### ${k}\n\n${render(finalState[k])}`)
    .join('\n\n');
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
  if (next.goalFrom) {
    const own = ctx[next.goalFrom];
    const goal = typeof own === 'string' && own.trim() ? own.trim() : prev.score.goal;
    const found = resultText(prev.score, state);
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
