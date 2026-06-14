/**
 * compiler.ts — Compiler: Pattern + problem + context → ExecutableScore.
 *
 * Two entry points:
 *   compileScore(pattern, { problem, context })  — the preferred path
 *   parseAlgorithm(input)                        — low-level fallback
 *
 * Pure deterministic shape conversion. No LLM, no classification.
 */

import { fingerprintProblem, computeExecutableScoreId } from "./persistence";
import { beatLegality, pairRationale } from "./legality";
import {
  LEVEL_ACTIVITY_THRESHOLD,
  LEVELS,
  type Beat,
  type DomainKey,
  type FrequencyMap,
  type InstrumentType,
  type Level,
  type ExecutableScore,
  type Voice,
} from "./types";
import type { Pattern, PatternScore } from "./pattern";

// ── Low-level Algorithm input ──────────────────────────────────────

export interface AlgorithmStep {
  readonly verb: string;
  readonly directive: string;
}

export interface AlgorithmAnnotation {
  readonly verb: string;
  readonly level: Level;
  readonly instrument: InstrumentType;
}

export interface AlgorithmProvenance {
  readonly pattern: string;
}

export interface AlgorithmInput {
  readonly problem: string;
  readonly domain: DomainKey;
  readonly steps: readonly AlgorithmStep[];
  readonly annotations: readonly AlgorithmAnnotation[];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly provenance?: AlgorithmProvenance;
  readonly generatedAt?: string;
}

// ── Derivation ─────────────────────────────────────────────────────

function buildFrequencyMap(beats: readonly Beat[], domain: DomainKey): FrequencyMap {
  const counts: Record<Level, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
  for (const beat of beats) {
    counts[beat.level] += 1;
  }
  const total = beats.length;
  const activeLevels =
    total === 0 ? [] : LEVELS.filter((l) => counts[l] / total >= LEVEL_ACTIVITY_THRESHOLD);
  return { key: domain, activeLevels };
}

function patternBeatsToBeats(score: PatternScore): readonly Beat[] {
  return score.beats.map((pb) => {
    const voices: readonly Voice[] = [{ instrument: pb.instrument }];
    return { level: pb.level, voices, directive: pb.directive };
  });
}

function assertBeatsLegal(beats: readonly Beat[], where: string): void {
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    if (beatLegality(beat.level, beat.voices) !== "illegal") {
      continue;
    }
    const offending = beat.voices.find(
      (v) => pairRationale(beat.level, v.instrument) !== undefined,
    );
    const rationale = offending ? pairRationale(beat.level, offending.instrument) : undefined;
    const voiceList = beat.voices.map((v) => v.instrument).join("+");
    throw new Error(
      `${where}: beat ${i} is illegal (level=${beat.level}, voices=${voiceList})` +
        (rationale ? ` \u2014 ${rationale}` : ""),
    );
  }
}

// ── Pattern path ───────────────────────────────────────────────────

export interface CompileArgs {
  readonly problem: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly generatedAt?: string;
}

export function compileScore(pattern: Pattern, args: CompileArgs): ExecutableScore {
  const context = args.context ?? {};
  for (const key of pattern.requiredContext) {
    const value = context[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0)
    ) {
      throw new Error(`compileScore: pattern "${pattern.score.pattern}" requires context.${key}`);
    }
  }

  const beats = patternBeatsToBeats(pattern.score);
  assertBeatsLegal(beats, `compileScore: pattern "${pattern.score.pattern}"`);
  const frequencyMap = buildFrequencyMap(beats, pattern.score.domain);
  const generatedFrom = fingerprintProblem(args.problem);

  const partial: Omit<ExecutableScore, "id" | "generatedAt"> = {
    schemaVersion: 1,
    frequencyMap,
    beats,
    generatedFrom,
    pattern: pattern.score.pattern,
    context: { ...context },
  };
  const id = computeExecutableScoreId(partial);
  const generatedAt = args.generatedAt ?? new Date().toISOString();

  return { ...partial, id, generatedAt };
}

// ── Low-level Algorithm path ───────────────────────────────────────

export function parseAlgorithm(input: AlgorithmInput): ExecutableScore {
  if (input.steps.length === 0) {
    throw new Error("parseAlgorithm: steps array is empty");
  }

  const annotationsByVerb = new Map<string, AlgorithmAnnotation>();
  for (const annotation of input.annotations) {
    if (annotationsByVerb.has(annotation.verb)) {
      throw new Error(`parseAlgorithm: duplicate annotation for verb "${annotation.verb}"`);
    }
    annotationsByVerb.set(annotation.verb, annotation);
  }

  const usedVerbs = new Set<string>();
  const beats: Beat[] = input.steps.map((step) => {
    const annotation = annotationsByVerb.get(step.verb);
    if (!annotation) {
      throw new Error(`parseAlgorithm: step "${step.verb}" has no matching annotation`);
    }
    usedVerbs.add(step.verb);
    const voices: readonly Voice[] = [{ instrument: annotation.instrument }];
    return { level: annotation.level, voices, directive: step.directive };
  });

  for (const verb of annotationsByVerb.keys()) {
    if (!usedVerbs.has(verb)) {
      throw new Error(`parseAlgorithm: annotation "${verb}" has no matching step`);
    }
  }

  assertBeatsLegal(beats, "parseAlgorithm");

  const frequencyMap = buildFrequencyMap(beats, input.domain);
  const generatedFrom = fingerprintProblem(input.problem);

  const base: Omit<ExecutableScore, "id" | "generatedAt"> = {
    schemaVersion: 1,
    frequencyMap,
    beats,
    generatedFrom,
  };
  const partial: Omit<ExecutableScore, "id" | "generatedAt"> = {
    ...base,
    ...(input.provenance ? { pattern: input.provenance.pattern } : {}),
    ...(input.context ? { context: { ...input.context } } : {}),
  };
  const id = computeExecutableScoreId(partial);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  return { ...partial, id, generatedAt };
}

// ── Pattern → AlgorithmInput ───────────────────────────────────────

export function algorithmFromPattern(pattern: Pattern, args: CompileArgs): AlgorithmInput {
  const context = args.context ?? {};
  for (const key of pattern.requiredContext) {
    const value = context[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0)
    ) {
      throw new Error(
        `algorithmFromPattern: pattern "${pattern.score.pattern}" requires context.${key}`,
      );
    }
  }
  const steps: readonly AlgorithmStep[] = pattern.score.beats.map((pb) => ({
    verb: pb.step,
    directive: pb.directive,
  }));
  const seen = new Map<string, AlgorithmAnnotation>();
  for (const pb of pattern.score.beats) {
    const prior = seen.get(pb.step);
    const next: AlgorithmAnnotation = { verb: pb.step, level: pb.level, instrument: pb.instrument };
    if (prior && (prior.level !== next.level || prior.instrument !== next.instrument)) {
      throw new Error(
        `algorithmFromPattern: pattern "${pattern.score.pattern}" has step "${pb.step}" with conflicting (level, instrument) across beats`,
      );
    }
    seen.set(pb.step, next);
  }
  const annotations: readonly AlgorithmAnnotation[] = Array.from(seen.values());
  return {
    problem: args.problem,
    domain: pattern.score.domain,
    steps,
    annotations,
    context: { ...context },
    provenance: { pattern: pattern.score.pattern },
    ...(args.generatedAt ? { generatedAt: args.generatedAt } : {}),
  };
}
