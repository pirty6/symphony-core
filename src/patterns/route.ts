import type { Pattern } from '../core/types.js';

/**
 * Whether a prompt contains a pattern's verb trigger as whole words, allowing the
 * usual verb endings: 'fix' matches "fixing" and "fixes", 'add' matches "added"
 * but not "address", 'data' does not match "database".
 */
export function triggerMatches(text: string, trigger: string): boolean {
  return triggerAt(text, trigger) >= 0;
}

/** Where a trigger first occurs in the prompt (as in triggerMatches), or -1. */
export function triggerAt(text: string, trigger: string): number {
  const t = trigger.trim().toLowerCase();
  if (!t) return -1;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const m = new RegExp(`(^|[^a-z0-9])${escaped}(?:s|es|ed|d|ing)?(?![a-z0-9])`, 'i').exec(text);
  return m ? m.index + m[1]!.length : -1;
}

/**
 * Patterns with at least one verb trigger in the prompt, best first: the most matching
 * triggers, where a trigger opening the request counts twice ("investigate how to
 * improve fix…"), then the earliest match; ties keep library order.
 */
export function routeMatches(prompt: string, library: readonly Pattern[]): Pattern[] {
  const text = prompt.toLowerCase();
  const lead = text.search(/[a-z0-9]/);
  return library
    .map((pattern, i) => {
      const at = (pattern.verbTriggers ?? []).map((t) => triggerAt(text, t)).filter((x) => x >= 0);
      const first = at.length ? Math.min(...at) : Infinity;
      // The opening verb counts once more: it usually names what is asked.
      return { pattern, i, first, score: at.length + (first === lead ? 1 : 0) };
    })
    .filter((m) => m.score > 0)
    .toSorted((a, b) => b.score - a.score || a.first - b.first || a.i - b.i)
    .map((m) => m.pattern);
}
