/**
 * types.ts — Core types for the Symphony orchestrator.
 *
 * Symphony decomposes a problem into a static frequency spectrum
 * (FrequencyMap) and plans a path through that spectrum
 * (ExecutableScore) which an orchestra of instrument-typed sub-agents
 * performs. The Performance is a separate artifact recording what
 * actually happened during execution.
 *
 * Design invariants (v1):
 *   1. Score ≠ Performance. A Score is a plan; a Performance is a
 *      recording. Beat holds plan-only fields; PerformedBeat holds
 *      execution fields.
 *   2. Beats are monophonic-by-default but the schema admits chords
 *      (Beat.voices: Voice[]). Length-1 = monophonic.
 *   3. Beats are flat. Loops and branches are deferred to schemaVersion 2.
 */

// ── Abstraction Levels ─────────────────────────────────────────────
// 1 = most concrete (raw artifact), 8 = most abstract (first principles).

export type Level = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const LEVELS: readonly Level[] = [1, 2, 3, 4, 5, 6, 7, 8] as const;

// ── Instruments ────────────────────────────────────────────────────
// Five epistemic modes, not five tools. The instrument constrains the
// kind of cognitive work performed at a beat, not the implementation.

export type InstrumentType =
  | "analyze"    // structural / relational
  | "decide"     // assertive / definitive
  | "question"   // exploratory / questioning
  | "order"      // ordering / timing
  | "integrate"; // harmonic / integrative

export const INSTRUMENTS: readonly InstrumentType[] = [
  "analyze",
  "decide",
  "question",
  "order",
  "integrate",
] as const;

// ── Domain Key ─────────────────────────────────────────────────────

export type DomainKey = string;

// ── Problem Fingerprint ────────────────────────────────────────────

export interface ProblemFingerprint {
  readonly rawHash: string;
  readonly canonicalHash: string;
  readonly schemaVersion: 1;
}

// ── Frequency Map ──────────────────────────────────────────────────

export interface FrequencyMap {
  readonly key: DomainKey;
  readonly activeLevels: readonly Level[];
}

export const LEVEL_ACTIVITY_THRESHOLD = 0.3;

// ── Legality ──────────────────────────────────────────────────────

export type Legality = "legal" | "unusual" | "illegal";

// ── Verdict ───────────────────────────────────────────────────────

export type VerdictOutcome = "applied" | "failed" | "skipped";

export interface MoveVerdict {
  readonly outcome: VerdictOutcome;
  readonly confidence: number;
  readonly shouldTerminate: boolean;
  readonly reason: string;
}

// ── Plan side: Score / Beat / Voice ────────────────────────────────

export interface Voice {
  readonly instrument: InstrumentType;
}

export interface Beat {
  readonly level: Level;
  readonly voices: readonly Voice[];
  readonly directive: string;
}

export interface ExecutableScore {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly frequencyMap: FrequencyMap;
  readonly beats: readonly Beat[];
  readonly generatedAt: string;
  readonly generatedFrom: ProblemFingerprint;
  readonly pattern?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

// ── Performance side ───────────────────────────────────────────────

export interface PerformedVoice {
  readonly instrument: InstrumentType;
  readonly output: string;
  readonly confidence: number;
  readonly producedBy?: string;
}

export interface PerformedBeat {
  readonly beatIndex: number;
  readonly voices: readonly PerformedVoice[];
  readonly verdict: MoveVerdict | undefined;
  readonly stateHash: string;
}

export type PerformanceOutcome = "success" | "partial" | "failed" | "in-progress";

export interface Performance {
  readonly scoreId: string;
  readonly beats: readonly PerformedBeat[];
  readonly startedAt: string;
  readonly completedAt: string | undefined;
  readonly outcome: PerformanceOutcome;
}

// ── Saved Run ──────────────────────────────────────────────────────

export interface SavedRun {
  readonly schemaVersion: 1;
  readonly patternScore: import("./pattern").PatternScore;
  readonly executableScore: ExecutableScore;
  readonly performance: Performance;
  readonly problemFingerprint: string;
  readonly timestamp: string;
}

// ── Divergence Report ──────────────────────────────────────────────

export interface VerdictDelta {
  readonly beatIndex: number;
  readonly saved: MoveVerdict | undefined;
  readonly fresh: MoveVerdict | undefined;
}

export interface HashDelta {
  readonly beatIndex: number;
  readonly saved: string;
  readonly fresh: string;
}

export interface DivergenceReport {
  readonly structural: boolean;
  readonly semantic: readonly VerdictDelta[];
  readonly environmental: readonly HashDelta[];
  readonly prose: number;
}
