// ── Core types ─────────────────────────────────────────────────────
export type {
  Level,
  InstrumentType,
  DomainKey,
  Legality,
  ProblemFingerprint,
  FrequencyMap,
  VerdictOutcome,
  MoveVerdict,
  Voice,
  Beat,
  ExecutableScore,
  PerformedVoice,
  PerformedBeat,
  PerformanceOutcome,
  Performance,
  SavedRun,
  VerdictDelta,
  HashDelta,
  DivergenceReport,
} from "./types";
export { LEVELS, INSTRUMENTS, LEVEL_ACTIVITY_THRESHOLD } from "./types";

// ── Pattern (Stage) ────────────────────────────────────────────────
export type { PatternBeat, PatternScore, Pattern } from "./pattern";

// ── Legality ───────────────────────────────────────────────────────
export { pairLegality, pairRationale, beatLegality, isLegalBeat } from "./legality";

// ── Validation ─────────────────────────────────────────────────────
export { validateVoiceOutputs, validateVerdict, validateScoreShape, VOICE_PRODUCERS } from "./validation";
export type { VoiceOutputInput, VoiceProducer } from "./validation";

// ── Persistence (pure) ─────────────────────────────────────────────
export { fingerprintProblem, computeExecutableScoreId, detectDivergence } from "./persistence";

// ── Compiler ───────────────────────────────────────────────────────
export { compileScore, parseAlgorithm, algorithmFromPattern } from "./compiler";
export type {
  AlgorithmStep,
  AlgorithmAnnotation,
  AlgorithmProvenance,
  AlgorithmInput,
  CompileArgs,
} from "./compiler";

// ── Perform ────────────────────────────────────────────────────────
export { performScore, scaffoldPerformance, deriveOutcome } from "./perform";
export type { BeatExecutorContext, BeatExecutorResult, BeatExecutor } from "./perform";

// ── Orchestrator ───────────────────────────────────────────────────
export {
  createEngine,
  advance,
  GO_PHRASES,
  DRAFT_MAX_ROUNDS,
} from "./orchestrator";
export type {
  AdvanceOptions,
  Pause,
  PatternSummary,
  PreviousBeatOutput,
  Resolution,
  OrchestratorEvent,
  EngineConfig,
  EngineResult,
  EngineState,
  AdvanceResult,
  InternalState,
  KindType,
  Complexity,
} from "./orchestrator";
