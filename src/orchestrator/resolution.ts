import type { Pattern } from "../pattern";
import type { MoveVerdict } from "../types";
import type {
  ClassifyComplexity,
  ConfirmFit,
  DraftPatternRound,
  ElicitContext,
  GoGate,
  KindType,
  PerformBeat,
} from "./kind";
import type { Complexity, VoiceProducer } from "./types";

interface ResolutionBase {
  readonly kind: KindType;
  readonly pauseId: string;
}

type ElicitContextResolution = ResolutionBase & {
  readonly kind: ElicitContext;
  readonly values: Readonly<Record<string, string>>;
};

type ConfirmFitResolution = ResolutionBase & {
  readonly kind: ConfirmFit;
  readonly ok: boolean;
  readonly reroute?: string;
};

type DraftPatternRoundResolution = ResolutionBase & {
  readonly kind: DraftPatternRound;
  readonly outcome: "approve" | "edit" | "ambiguous";
  readonly nextDraft?: Pattern;
};

type ClassifyComplexityResolution = ResolutionBase & {
  readonly kind: ClassifyComplexity;
  readonly complexity: Complexity;
};

type GoGateResolution = ResolutionBase & {
  readonly kind: GoGate;
  readonly phrase: string;
};

type PerformBeatResolution = ResolutionBase & {
  readonly kind: PerformBeat;
  readonly voiceOutputs: readonly {
    readonly instrument: string;
    readonly output: string;
    readonly confidence: number;
    readonly producedBy: VoiceProducer;
  }[];
  readonly verdict: MoveVerdict;
};

export type Resolution =
  | ConfirmFitResolution
  | ElicitContextResolution
  | ClassifyComplexityResolution
  | DraftPatternRoundResolution
  | GoGateResolution
  | PerformBeatResolution;
