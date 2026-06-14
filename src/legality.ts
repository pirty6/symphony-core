/**
 * legality.ts — The (Level, Instrument) legality matrix.
 *
 * Three-valued:
 *   - illegal  → score validator rejects
 *   - unusual  → score generator applies a path-planning penalty
 *   - legal    → no constraint
 *
 * Any pair not listed defaults to legal. Demotions of unusual → legal
 * should come from observed Performance success rates, not intuition.
 */

import type { InstrumentType, Legality, Level, Voice } from "./types";

interface LegalityRule {
  readonly level: Level;
  readonly instrument: InstrumentType;
  readonly verdict: Exclude<Legality, "legal">;
  readonly rationale: string;
}

const RULES: readonly LegalityRule[] = [
  {
    level: 1,
    instrument: "question",
    verdict: "illegal",
    rationale: "exploration has no surface area at the artifact level — read, do not explore",
  },
  {
    level: 1,
    instrument: "integrate",
    verdict: "illegal",
    rationale: "nothing to integrate at the artifact level — no other voices have been heard yet",
  },
  {
    level: 7,
    instrument: "order",
    verdict: "illegal",
    rationale: "first principles do not have a sequence — ordering presupposes operations to order",
  },
  {
    level: 8,
    instrument: "order",
    verdict: "illegal",
    rationale: "first principles do not have a sequence — ordering presupposes operations to order",
  },
  {
    level: 8,
    instrument: "decide",
    verdict: "unusual",
    rationale: "assertion at the level of pure philosophy is possible but rarely productive",
  },
];

export function pairLegality(level: Level, instrument: InstrumentType): Legality {
  for (const rule of RULES) {
    if (rule.level === level && rule.instrument === instrument) {
      return rule.verdict;
    }
  }
  return "legal";
}

export function pairRationale(level: Level, instrument: InstrumentType): string | undefined {
  for (const rule of RULES) {
    if (rule.level === level && rule.instrument === instrument) {
      return rule.rationale;
    }
  }
  return undefined;
}

export function beatLegality(level: Level, voices: readonly Voice[]): Legality {
  let worst: Legality = "legal";
  for (const v of voices) {
    const l = pairLegality(level, v.instrument);
    if (l === "illegal") {
      return "illegal";
    }
    if (l === "unusual") {
      worst = "unusual";
    }
  }
  return worst;
}

export function isLegalBeat(level: Level, voices: readonly Voice[]): boolean {
  return beatLegality(level, voices) !== "illegal";
}
