import type { Pattern } from '../core/types.js';
import { fix } from './fix.js';
import { hangman } from './hangman.js';
import { investigate } from './investigate.js';
import { review } from './review.js';

/** The pattern library. Patterns are TypeScript modules; add new ones here. */
export const PATTERNS: readonly Pattern[] = [investigate, fix, review, hangman];

export function findPattern(name: string): Pattern | undefined {
  return PATTERNS.find((p) => p.name === name);
}

/** Pick the pattern whose verb triggers best match a prompt (simple, deterministic). */
export function routePrompt(prompt: string): Pattern | undefined {
  const text = prompt.toLowerCase();
  let best: { pattern: Pattern; score: number } | undefined;
  for (const pattern of PATTERNS) {
    const score = (pattern.verbTriggers ?? []).filter((t) => text.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { pattern, score };
  }
  return best?.pattern;
}

export { fix, hangman, investigate, review };
