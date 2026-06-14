/**
 * pattern.ts — Types for the Pattern library (Stages).
 *
 * A Pattern is a reusable algorithm template (a "Stage") with:
 *   - A static skeleton of beats (PatternScore)
 *   - Required context keys the compiler validates at compile time
 *   - A description for routing
 *
 * The compiler converts a Pattern + concrete context into an
 * ExecutableScore. The Pattern is the plan template; the Score
 * is the per-problem executable artifact.
 */

import type { DomainKey, InstrumentType, Level } from "./types";

export interface PatternBeat {
  readonly step: string;
  readonly level: Level;
  readonly instrument: InstrumentType;
  readonly directive: string;
}

export interface PatternScore {
  readonly pattern: string;
  readonly domain: DomainKey;
  readonly beats: readonly PatternBeat[];
}

export interface Pattern {
  readonly score: PatternScore;
  readonly description: string;
  readonly requiredContext: readonly string[];
}
