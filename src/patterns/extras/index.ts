/**
 * Optional patterns: not part of the core library. Turn them on with
 * SYMPHONY_EXTRAS (a comma-separated list of names, or "all"), e.g.
 * SYMPHONY_EXTRAS=metaphor,storm-in-between npm start
 */
import type { Pattern } from '../../core/types.js';
import { metaphor } from './metaphor.js';
import { stormInBetween } from './storm-in-between.js';

export const EXTRAS: readonly Pattern[] = [metaphor, stormInBetween];

/** The extras SYMPHONY_EXTRAS turns on (none by default). */
export function enabledExtras(env: Readonly<Record<string, string | undefined>>): Pattern[] {
  const wanted = new Set(
    (env.SYMPHONY_EXTRAS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (wanted.has('all')) return [...EXTRAS];
  return EXTRAS.filter((p) => wanted.has(p.name));
}

export { metaphor, stormInBetween };
