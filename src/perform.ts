/**
 * perform.ts — Score executor.
 *
 * Takes a Score (the plan) and a per-beat executor function
 * (supplied by the caller — agent harness, human, etc.) and
 * produces a Performance (the recording).
 *
 * No LLM in this module. The executor callback is the seam where
 * an agent harness supplies the actual beat work.
 */

import * as crypto from "node:crypto";

import type {
  Beat,
  MoveVerdict,
  Performance,
  PerformanceOutcome,
  PerformedBeat,
  PerformedVoice,
  ExecutableScore,
} from "./types";

// ── Executor callback ──────────────────────────────────────────────

export interface BeatExecutorContext {
  readonly beatIndex: number;
  readonly beat: Beat;
  readonly score: ExecutableScore;
  readonly previous: readonly PerformedBeat[];
}

export interface BeatExecutorResult {
  readonly voices: readonly PerformedVoice[];
  readonly verdict: MoveVerdict | undefined;
  readonly stateHash?: string;
}

export type BeatExecutor = (
  ctx: BeatExecutorContext,
) => BeatExecutorResult | Promise<BeatExecutorResult>;

// ── Public API ─────────────────────────────────────────────────────

export async function performScore(
  score: ExecutableScore,
  executeBeat: BeatExecutor,
  clock: () => string = () => new Date().toISOString(),
): Promise<Performance> {
  const startedAt = clock();
  const performed: PerformedBeat[] = [];
  let terminatedEarly = false;

  for (let i = 0; i < score.beats.length; i += 1) {
    const beat = score.beats[i];
    const result = await executeBeat({
      beatIndex: i,
      beat,
      score,
      previous: performed,
    });
    const stateHash = result.stateHash ?? defaultStateHash(score.id, i);
    performed.push({
      beatIndex: i,
      voices: result.voices,
      verdict: result.verdict,
      stateHash,
    });
    if (result.verdict?.shouldTerminate) {
      terminatedEarly = true;
      break;
    }
  }

  const outcome = deriveOutcome(performed, terminatedEarly);

  return {
    scoreId: score.id,
    beats: performed,
    startedAt,
    completedAt: clock(),
    outcome,
  };
}

export function scaffoldPerformance(
  score: ExecutableScore,
  clock: () => string = () => new Date().toISOString(),
): Performance {
  const beats: PerformedBeat[] = score.beats.map((beat, i) => ({
    beatIndex: i,
    voices: beat.voices.map((voice) => ({
      instrument: voice.instrument,
      output: "",
      confidence: 0,
    })),
    verdict: undefined,
    stateHash: defaultStateHash(score.id, i),
  }));
  return {
    scoreId: score.id,
    beats,
    startedAt: clock(),
    completedAt: undefined,
    outcome: "in-progress",
  };
}

// ── Internals ──────────────────────────────────────────────────────

function defaultStateHash(scoreId: string, beatIndex: number): string {
  return crypto.createHash("sha256").update(`scaffold:${scoreId}:${beatIndex}`).digest("hex");
}

export function deriveOutcome(
  beats: readonly PerformedBeat[],
  terminatedEarly: boolean,
): PerformanceOutcome {
  if (beats.length === 0) {
    return "in-progress";
  }
  if (beats.some((b) => b.verdict?.outcome === "failed")) {
    return "failed";
  }
  if (terminatedEarly) {
    const last = beats[beats.length - 1].verdict;
    return last?.outcome === "applied" ? "success" : "partial";
  }
  if (!beats.some((b) => b.verdict?.outcome === "applied")) {
    return "partial";
  }
  return "success";
}
