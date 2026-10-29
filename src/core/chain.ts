/**
 * Chaining patterns: one pattern's result feeds the next (investigate -> fix,
 * investigate -> refactor). Pure: it only builds the next run's inputs. Each
 * run stays its own score and performance, linked by what was handed over.
 */
import type { ExecutableScore, Pattern, Performance } from './types.js';

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
