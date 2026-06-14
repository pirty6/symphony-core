/**
 * persistence.ts — Hashing, fingerprinting, and divergence detection.
 *
 * Pure functions for Score ID computation and replay comparison.
 * No filesystem I/O — storage is the caller's responsibility.
 */

import * as crypto from "node:crypto";

import type {
  DivergenceReport,
  ExecutableScore,
  HashDelta,
  MoveVerdict,
  Performance,
  PerformedBeat,
  ProblemFingerprint,
  VerdictDelta,
} from "./types";

// ── Hashing ────────────────────────────────────────────────────────

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function fingerprintProblem(statement: string): ProblemFingerprint {
  const raw = sha256(statement);
  return { rawHash: raw, canonicalHash: raw, schemaVersion: 1 };
}

export function computeExecutableScoreId(
  score: Omit<ExecutableScore, "id" | "generatedAt">,
): string {
  const base: Record<string, unknown> = {
    schemaVersion: score.schemaVersion,
    frequencyMap: score.frequencyMap,
    beats: score.beats,
    generatedFrom: score.generatedFrom,
  };
  if (score.pattern !== undefined) {
    base["pattern"] = score.pattern;
  }
  if (score.context !== undefined) {
    base["context"] = score.context;
  }
  return sha256(JSON.stringify(base));
}

// ── Divergence ─────────────────────────────────────────────────────

function verdictsEqual(a: MoveVerdict | undefined, b: MoveVerdict | undefined): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return (
    a.outcome === b.outcome &&
    a.confidence === b.confidence &&
    a.shouldTerminate === b.shouldTerminate &&
    a.reason === b.reason
  );
}

function proseDiffersAtBeat(saved: PerformedBeat, fresh: PerformedBeat): boolean {
  if (saved.voices.length !== fresh.voices.length) {
    return true;
  }
  for (let i = 0; i < saved.voices.length; i += 1) {
    if (saved.voices[i].output !== fresh.voices[i].output) {
      return true;
    }
  }
  return false;
}

export function detectDivergence(saved: Performance, fresh: Performance): DivergenceReport {
  if (saved.scoreId !== fresh.scoreId) {
    return { structural: true, semantic: [], environmental: [], prose: 0 };
  }
  if (saved.beats.length !== fresh.beats.length) {
    return { structural: true, semantic: [], environmental: [], prose: 0 };
  }

  const semantic: VerdictDelta[] = [];
  const environmental: HashDelta[] = [];
  let prose = 0;

  for (let i = 0; i < saved.beats.length; i += 1) {
    const s = saved.beats[i];
    const f = fresh.beats[i];

    if (s.beatIndex !== f.beatIndex) {
      return { structural: true, semantic: [], environmental: [], prose: 0 };
    }
    if (!verdictsEqual(s.verdict, f.verdict)) {
      semantic.push({ beatIndex: i, saved: s.verdict, fresh: f.verdict });
    }
    if (s.stateHash !== f.stateHash) {
      environmental.push({ beatIndex: i, saved: s.stateHash, fresh: f.stateHash });
    }
    if (proseDiffersAtBeat(s, f)) {
      prose += 1;
    }
  }

  return { structural: false, semantic, environmental, prose };
}
