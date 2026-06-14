/**
 * event.ts — Typed event system for the orchestrator engine.
 *
 * Events are return values from createEngine() and advance(), not
 * side effects. The engine remains a pure reducer.
 */

import type { KindType } from "./kind";
import type { Complexity } from "./types";
import type { VerdictOutcome } from "../types";

export interface RunStartedEvent {
  readonly kind: "run-started";
  readonly prompt: string;
  readonly pattern: string;
}

export interface PauseEmittedEvent {
  readonly kind: "pause-emitted";
  readonly pauseKind: KindType;
  readonly pauseId: string;
}

export interface PatternConfirmedEvent {
  readonly kind: "pattern-confirmed";
  readonly pattern: string;
}

export interface PatternReroutedEvent {
  readonly kind: "pattern-rerouted";
  readonly from: string;
  readonly to: string;
}

export interface ComplexityClassifiedEvent {
  readonly kind: "complexity-classified";
  readonly complexity: Complexity;
}

export interface DraftRoundCompletedEvent {
  readonly kind: "draft-round-completed";
  readonly round: number;
  readonly outcome: "approve" | "edit" | "ambiguous";
}

export interface ContextCollectedEvent {
  readonly kind: "context-collected";
  readonly keys: readonly string[];
  readonly missingKeys: readonly string[];
}

export interface ScoreCompiledEvent {
  readonly kind: "score-compiled";
  readonly scoreId: string;
  readonly beatCount: number;
}

export interface BeatStartedEvent {
  readonly kind: "beat-started";
  readonly beatIndex: number;
  readonly directive: string;
}

export interface BeatCompletedEvent {
  readonly kind: "beat-completed";
  readonly beatIndex: number;
  readonly verdictOutcome: VerdictOutcome;
  readonly confidence: number;
}

export interface RunCompletedEvent {
  readonly kind: "run-completed";
  readonly outcome: string;
  readonly beatCount: number;
}

export interface RunFailedEvent {
  readonly kind: "run-failed";
  readonly error: string;
}

export interface RunPlannedEvent {
  readonly kind: "run-planned";
  readonly outPath?: string;
}

export type OrchestratorEvent =
  | RunStartedEvent
  | PauseEmittedEvent
  | PatternConfirmedEvent
  | PatternReroutedEvent
  | ComplexityClassifiedEvent
  | DraftRoundCompletedEvent
  | ContextCollectedEvent
  | ScoreCompiledEvent
  | BeatStartedEvent
  | BeatCompletedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunPlannedEvent;
