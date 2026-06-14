import type { Pattern, PatternScore } from "../pattern";
import type { AlgorithmInput } from "../compiler";
import type { ExecutableScore, Performance, PerformedBeat } from "../types";
import type { Pause } from "./pause";
import type { OrchestratorEvent } from "./event";

export interface EngineConfig {
  readonly prompt: string;
  readonly patterns: readonly Pattern[];
  readonly pattern: string;
  readonly planOnly?: boolean;
  readonly outPath?: string;
  readonly clock?: () => string;
  readonly pauseIdFactory?: () => string;
}

export interface EngineResult {
  readonly executableScore: ExecutableScore;
  readonly performance: Performance;
  readonly patternScore: PatternScore;
}

export interface InternalState {
  readonly prompt: string;
  readonly patterns: readonly Pattern[];
  readonly active: { readonly patternName: string } | undefined;
  readonly context: Readonly<Record<string, string>>;
  readonly draftRound: number;
  readonly score: ExecutableScore | undefined;
  readonly performedBeats: readonly PerformedBeat[];
  readonly startedAt: string;
  readonly planOnly: boolean;
  readonly outPath?: string;
}

type RunningState = {
  readonly kind: "running";
  readonly pause: Pause;
  readonly internal: InternalState;
};

type DoneState = {
  readonly kind: "done";
  readonly result: EngineResult;
};

type PlannedState = {
  readonly kind: "planned";
  readonly algorithm: AlgorithmInput;
  readonly outPath?: string;
};

type FailedState = {
  readonly kind: "failed";
  readonly error: string;
};

export type EngineState = RunningState | DoneState | PlannedState | FailedState;

export type AdvanceResult = EngineState & { readonly events: readonly OrchestratorEvent[] };
