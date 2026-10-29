import { DEMO_ONLY } from '../core/catalog.js';
import type { Pattern } from '../core/types.js';
import { backlog } from './backlog.js';
import { fix } from './fix.js';
import { hangman } from './hangman.js';
import { implement } from './implement.js';
import { analyze } from './analyze.js';
import { investigate } from './investigate.js';
import { enabledExtras } from './extras/index.js';
import { composedScore, maestro, maestroThen } from './maestro.js';
import { refactor } from './refactor.js';
import { review } from './review.js';
import { triggerMatches } from './route.js';

/** The pattern library. Patterns are TypeScript modules; add new ones here. */
export const PATTERNS: readonly Pattern[] = [
  maestro,
  investigate,
  fix,
  refactor,
  implement,
  backlog,
  review,
  analyze,
  hangman,
];

/**
 * The library a run can use: the core patterns, the optional ones turned on in
 * env (SYMPHONY_EXTRAS), then saved drafts that do not reuse one of their names.
 */
export function libraryPatterns(
  env: Readonly<Record<string, string | undefined>>,
  drafts: readonly Pattern[] = [],
): Pattern[] {
  const known = [...PATTERNS, ...enabledExtras(env)];
  return [...known, ...drafts.filter((d) => !known.some((p) => p.name === d.name))];
}

/** Core patterns that do work (hangman is a demo game): what integrations list. */
export function workPatternNames(): string[] {
  return PATTERNS.filter((p) => !DEMO_ONLY.has(p.name)).map((p) => p.name);
}

export function findPattern(name: string): Pattern | undefined {
  return PATTERNS.find((p) => p.name === name);
}

/** Pick the pattern whose verb triggers best match a prompt (simple, deterministic). */
export function routePrompt(
  prompt: string,
  library: readonly Pattern[] = PATTERNS,
): Pattern | undefined {
  return routeMatches(prompt, library)[0];
}

/** Patterns with at least one verb trigger in the prompt, best first (ties keep library order). */
export function routeMatches(prompt: string, library: readonly Pattern[]): Pattern[] {
  const text = prompt.toLowerCase();
  return library
    .map((pattern, i) => ({
      pattern,
      i,
      score: (pattern.verbTriggers ?? []).filter((t) => triggerMatches(text, t)).length,
    }))
    .filter((m) => m.score > 0)
    .toSorted((a, b) => b.score - a.score || a.i - b.i)
    .map((m) => m.pattern);
}

export {
  analyze,
  backlog,
  composedScore,
  fix,
  hangman,
  implement,
  investigate,
  maestro,
  maestroThen,
  refactor,
  review,
};
