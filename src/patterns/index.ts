import type { Pattern } from '../core/types.js';
import { fix } from './fix.js';
import { hangman } from './hangman.js';
import { analyze } from './analyze.js';
import { investigate } from './investigate.js';
import { composedScore, maestro, maestroThen } from './maestro.js';
import { refactor } from './refactor.js';
import { review } from './review.js';

/** The pattern library. Patterns are TypeScript modules; add new ones here. */
export const PATTERNS: readonly Pattern[] = [
  maestro,
  investigate,
  fix,
  refactor,
  review,
  analyze,
  hangman,
];

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
      score: (pattern.verbTriggers ?? []).filter((t) => text.includes(t)).length,
    }))
    .filter((m) => m.score > 0)
    .toSorted((a, b) => b.score - a.score || a.i - b.i)
    .map((m) => m.pattern);
}

export {
  analyze,
  composedScore,
  fix,
  hangman,
  investigate,
  maestro,
  maestroThen,
  refactor,
  review,
};
