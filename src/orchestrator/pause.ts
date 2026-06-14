import type { Pattern } from "../pattern";
import type { Beat, VerdictOutcome } from "../types";
import type {
  ClassifyComplexity,
  ConfirmFit,
  DraftPatternRound,
  ElicitContext,
  GoGate,
  KindType,
  PerformBeat,
} from "./kind";
import type { Complexity } from "./types";

interface BasePause {
  readonly kind: KindType;
  readonly pauseId: string;
  readonly payload: {};
  readonly composerPrompt: string;
  readonly instrumentPrompt: string;
}

export interface PatternSummary {
  readonly pattern: string;
  readonly description: string;
}

export interface PreviousBeatOutput {
  readonly beatIndex: number;
  readonly directive: string;
  readonly voices: readonly {
    readonly instrument: string;
    readonly output: string;
  }[];
  readonly verdictOutcome: VerdictOutcome;
}

type ConfirmFitPause = BasePause & {
  readonly kind: ConfirmFit;
  readonly payload: {
    readonly pattern: string;
    readonly description: string;
  };
};

type ClassifyComplexityPause = BasePause & {
  readonly kind: ClassifyComplexity;
  readonly payload: {
    readonly prompt: string;
  };
};

type DraftPatternRoundPause = BasePause & {
  readonly kind: DraftPatternRound;
  readonly payload: {
    readonly round: number;
    readonly maxRounds: number;
    readonly complexity: Complexity;
    readonly baseHint: Complexity;
    readonly priorDraft: Pattern | undefined;
  };
};

type ElicitContextPause = BasePause & {
  readonly kind: ElicitContext;
  readonly payload: {
    readonly pattern: string;
    readonly missingKeys: readonly string[];
    readonly collected: Readonly<Record<string, string>>;
  };
};

type GoGatePause = BasePause & {
  readonly kind: GoGate;
  readonly payload: {
    readonly pattern: string;
    readonly context: Readonly<Record<string, string>>;
    readonly beats: number;
  };
};

type PerformBeatPause = BasePause & {
  readonly kind: PerformBeat;
  readonly payload: {
    readonly beatIndex: number;
    readonly beat: Beat;
    readonly previousOutputs: readonly PreviousBeatOutput[];
  };
};

export type Pause =
  | ConfirmFitPause
  | ClassifyComplexityPause
  | DraftPatternRoundPause
  | ElicitContextPause
  | GoGatePause
  | PerformBeatPause;
