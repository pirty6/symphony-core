/**
 * engine.ts — Orchestrator state machine.
 *
 * Pure reducer. createEngine + advance. No fs, no LLM, no network.
 * Caller drives the loop and supplies a Resolution at every Pause.
 *
 * The state machine enforces:
 *   - elicit-context non-empty (re-emits while any required key blank)
 *   - go-gate canonical phrases only
 *   - draft-pattern MAX_ROUNDS=6
 *   - perform-beat shape validation
 *
 * EngineState is JSON-round-trippable: callers may persist a state
 * object between turns and resume by passing it back to advance().
 */

import * as crypto from "node:crypto";

import type { Pattern } from "../pattern";
import type {
  Beat,
  ExecutableScore,
  Performance,
  PerformedBeat,
  PerformedVoice,
} from "../types";
import { compileScore, algorithmFromPattern } from "../compiler";
import { scaffoldPerformance, deriveOutcome } from "../perform";
import { validateVerdict, validateVoiceOutputs } from "../validation";
import type { Pause, PatternSummary } from "./pause";
import type { Resolution } from "./resolution";
import type { Complexity } from "./types";
import type { AdvanceResult, EngineConfig, EngineState, InternalState } from "./state";
import type { OrchestratorEvent } from "./event";

// ── Public constants ────────────────────────────────────────────────

export const GO_PHRASES = ["go", "approved", "looks good", "ship it", "proceed"] as const;

export const DRAFT_MAX_ROUNDS = 6;

// ── Defaults ────────────────────────────────────────────────────────

function defaultClock(): string {
  return new Date().toISOString();
}

function defaultPauseIdFactory(): string {
  return crypto.randomUUID();
}

// ── Hash helper ─────────────────────────────────────────────────────

function stateHashFor(scoreId: string, beatIndex: number): string {
  return crypto.createHash("sha256").update(`engine:${scoreId}:${beatIndex}`).digest("hex");
}

// ── Event helpers ───────────────────────────────────────────────────

function withEvents(state: EngineState, events: readonly OrchestratorEvent[]): AdvanceResult {
  return Object.assign({}, state, { events }) as AdvanceResult;
}

function appendTerminalEvents(state: EngineState, events: OrchestratorEvent[]): void {
  switch (state.kind) {
    case "running":
      if (state.pause.kind === "perform-beat") {
        events.push({
          kind: "beat-started",
          beatIndex: state.pause.payload.beatIndex,
          directive: state.pause.payload.beat.directive,
        });
      }
      events.push({
        kind: "pause-emitted",
        pauseKind: state.pause.kind,
        pauseId: state.pause.pauseId,
      });
      break;
    case "done":
      events.push({
        kind: "run-completed",
        outcome: state.result.performance.outcome,
        beatCount: state.result.performance.beats.length,
      });
      break;
    case "failed":
      events.push({ kind: "run-failed", error: state.error });
      break;
    case "planned":
      events.push({ kind: "run-planned", outPath: state.outPath });
      break;
  }
}

// ── Factory ─────────────────────────────────────────────────────────

export interface AdvanceOptions {
  readonly clock?: () => string;
  readonly pauseIdFactory?: () => string;
}

export function createEngine(config: EngineConfig): AdvanceResult {
  const clock = config.clock ?? defaultClock;
  const newPauseId = config.pauseIdFactory ?? defaultPauseIdFactory;
  const prompt = config.prompt;
  const pattern = config.pattern;

  const events: OrchestratorEvent[] = [];
  events.push({ kind: "run-started", prompt, pattern });

  const internal: InternalState = {
    prompt,
    patterns: config.patterns,
    active: undefined,
    context: {},
    draftRound: 0,
    score: undefined,
    performedBeats: [],
    startedAt: clock(),
    planOnly: config.planOnly ?? false,
    ...(config.outPath !== undefined ? { outPath: config.outPath } : {}),
  };

  if (pattern === "new") {
    const state = enterClassifyComplexity(internal, newPauseId);
    appendTerminalEvents(state, events);
    return withEvents(state, events);
  }
  const target = findPattern(internal.patterns, pattern);
  if (!target) {
    const state = failed(`createEngine: pattern '${pattern}' not registered (use "new" to draft)`);
    appendTerminalEvents(state, events);
    return withEvents(state, events);
  }
  const state = enterConfirmFit(internal, summaryOf(target), newPauseId);
  appendTerminalEvents(state, events);
  return withEvents(state, events);
}

// ── Reducer ─────────────────────────────────────────────────────────

export function advance(
  state: EngineState,
  resolution: Resolution,
  opts: AdvanceOptions = {},
): AdvanceResult {
  if (state.kind !== "running") {
    return withEvents(state, []);
  }
  const pause = state.pause;
  const internal = state.internal;
  const clock = opts.clock ?? defaultClock;
  const newPauseId = opts.pauseIdFactory ?? defaultPauseIdFactory;

  const events: OrchestratorEvent[] = [];

  if (pause.kind !== resolution.kind) {
    const next = failed(
      `resolution kind '${resolution.kind}' does not match pause '${pause.kind}'`,
    );
    appendTerminalEvents(next, events);
    return withEvents(next, events);
  }

  if (typeof resolution.pauseId !== "string" || resolution.pauseId === "") {
    const next = failed(
      `${pause.kind}: resolution.pauseId is required (expected '${pause.pauseId}')`,
    );
    appendTerminalEvents(next, events);
    return withEvents(next, events);
  }
  if (resolution.pauseId !== pause.pauseId) {
    const next = failed(
      `${pause.kind}: pauseId mismatch (got '${resolution.pauseId}', expected '${pause.pauseId}')`,
    );
    appendTerminalEvents(next, events);
    return withEvents(next, events);
  }

  let next!: EngineState;
  switch (pause.kind) {
    case "confirm-fit":
      next = resolveConfirmFit(internal, resolution as ConfirmRes, newPauseId, events);
      break;
    case "classify-complexity":
      next = resolveClassifyComplexity(internal, resolution as ClassifyRes, newPauseId, events);
      break;
    case "draft-pattern-round":
      next = resolveDraftRound(internal, resolution as DraftRes, pause, newPauseId, events);
      break;
    case "elicit-context":
      next = resolveElicitContext(internal, resolution as ElicitRes, newPauseId, events);
      break;
    case "go-gate":
      next = resolveGoGate(internal, resolution as GoRes, clock, newPauseId, events);
      break;
    case "perform-beat":
      next = resolvePerformBeat(internal, resolution as PerformRes, pause, clock, newPauseId, events);
      break;
  }
  appendTerminalEvents(next, events);
  return withEvents(next, events);
}

// ── Phase 1 transitions ────────────────────────────────────────────

type ConfirmRes = Extract<Resolution, { kind: "confirm-fit" }>;
type ClassifyRes = Extract<Resolution, { kind: "classify-complexity" }>;
type DraftRes = Extract<Resolution, { kind: "draft-pattern-round" }>;
type ElicitRes = Extract<Resolution, { kind: "elicit-context" }>;
type GoRes = Extract<Resolution, { kind: "go-gate" }>;
type PerformRes = Extract<Resolution, { kind: "perform-beat" }>;

function resolveConfirmFit(
  internal: InternalState,
  res: ConfirmRes,
  nid: () => string,
  events: OrchestratorEvent[],
): EngineState {
  if (!internal.active) {
    return failed("confirm-fit: no active pattern");
  }
  if (res.ok) {
    events.push({ kind: "pattern-confirmed", pattern: internal.active.patternName });
    return enterAfterConfirmFit(internal, nid);
  }
  if (res.reroute) {
    events.push({ kind: "pattern-rerouted", from: internal.active.patternName, to: res.reroute });
    const target = findPattern(internal.patterns, res.reroute);
    if (!target) {
      return failed(`confirm-fit: reroute target '${res.reroute}' not registered`);
    }
    const cleared: InternalState = { ...internal, active: undefined, context: {} };
    return enterConfirmFit(cleared, summaryOf(target), nid);
  }
  return failed(
    "confirm-fit: rejected without reroute target; restart with a new pattern",
  );
}

function resolveDraftRound(
  internal: InternalState,
  res: DraftRes,
  pause: Extract<Pause, { kind: "draft-pattern-round" }>,
  nid: () => string,
  events: OrchestratorEvent[],
): EngineState {
  events.push({ kind: "draft-round-completed", round: pause.payload.round, outcome: res.outcome });
  if (res.outcome === "approve") {
    if (!res.nextDraft) {
      return failed("draft-pattern-round: approve requires nextDraft");
    }
    const draft = res.nextDraft;
    const augmentedPatterns = [...internal.patterns, draft];
    return enterAfterConfirmFit(
      {
        ...internal,
        patterns: augmentedPatterns,
        active: { patternName: draft.score.pattern },
        context: {},
      },
      nid,
    );
  }
  const next = pause.payload.round + 1;
  if (next > DRAFT_MAX_ROUNDS) {
    return failed(`draft-pattern: MAX_ROUNDS=${DRAFT_MAX_ROUNDS} exceeded`);
  }
  return enterDraftPatternRound(
    internal,
    next,
    pause.payload.baseHint,
    res.nextDraft ?? pause.payload.priorDraft,
    nid,
  );
}

// ── Phase 2 transitions ────────────────────────────────────────────

function resolveElicitContext(
  internal: InternalState,
  res: ElicitRes,
  nid: () => string,
  events: OrchestratorEvent[],
): EngineState {
  if (!internal.active) {
    return failed("elicit-context: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("elicit-context: active pattern not registered");
  }
  const required = activePattern.requiredContext;
  const merged: Record<string, string> = { ...internal.context };
  for (const key of required) {
    const v = res.values[key];
    if (typeof v === "string" && v.trim() !== "") {
      merged[key] = v.trim();
    }
  }
  const missing = required.filter((k) => !merged[k]);
  const filledKeys = required.filter((k) => !!merged[k]);
  events.push({ kind: "context-collected", keys: filledKeys, missingKeys: missing });
  const next: InternalState = { ...internal, context: merged };
  if (missing.length > 0) {
    return runningPause(next, makeElicitPause(activePattern, merged, missing, nid));
  }
  return enterGoGate(next, nid);
}

function resolveGoGate(
  internal: InternalState,
  res: GoRes,
  clock: () => string,
  nid: () => string,
  events: OrchestratorEvent[],
): EngineState {
  if (!internal.active) {
    return failed("go-gate: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("go-gate: active pattern not registered");
  }
  const phrase = res.phrase.trim().toLowerCase();
  if (!(GO_PHRASES as readonly string[]).includes(phrase)) {
    return runningPause(internal, makeGoGatePause(activePattern, internal.context, nid));
  }
  if (internal.planOnly) {
    try {
      const algorithm = algorithmFromPattern(activePattern, {
        problem: internal.prompt,
        context: internal.context,
        generatedAt: clock(),
      });
      return {
        kind: "planned",
        algorithm,
        ...(internal.outPath !== undefined ? { outPath: internal.outPath } : {}),
      };
    } catch (e) {
      return failed(`go-gate: algorithmFromPattern failed: ${(e as Error).message}`);
    }
  }
  let score: ExecutableScore;
  try {
    score = compileScore(activePattern, {
      problem: internal.prompt,
      context: internal.context,
    });
  } catch (e) {
    return failed(`go-gate: compileScore failed: ${(e as Error).message}`);
  }
  events.push({ kind: "score-compiled", scoreId: score.id, beatCount: score.beats.length });
  const seeded: InternalState = {
    ...internal,
    score,
    performedBeats: [],
    startedAt: clock(),
  };
  return enterPerformBeat(seeded, 0, nid);
}

// ── Phase 3 transitions ────────────────────────────────────────────

function resolvePerformBeat(
  internal: InternalState,
  res: PerformRes,
  pause: Extract<Pause, { kind: "perform-beat" }>,
  clock: () => string,
  nid: () => string,
  events: OrchestratorEvent[],
): EngineState {
  const shapeError = validateVoiceOutputs(res.voiceOutputs, pause.payload.beat);
  if (shapeError) {
    return failed(`perform-beat[${pause.payload.beatIndex}]: ${shapeError}`);
  }
  const verdictError = validateVerdict(res.verdict);
  if (verdictError) {
    return failed(`perform-beat[${pause.payload.beatIndex}]: ${verdictError}`);
  }
  if (!internal.score) {
    return failed("perform-beat: no compiled score");
  }
  events.push({
    kind: "beat-completed",
    beatIndex: pause.payload.beatIndex,
    verdictOutcome: res.verdict.outcome,
    confidence: res.verdict.confidence,
  });

  const performed: PerformedBeat = {
    beatIndex: pause.payload.beatIndex,
    voices: res.voiceOutputs.map<PerformedVoice>((v) => ({
      instrument: v.instrument as PerformedVoice["instrument"],
      output: v.output,
      confidence: v.confidence,
      producedBy: v.producedBy,
    })),
    verdict: res.verdict,
    stateHash: stateHashFor(internal.score.id, pause.payload.beatIndex),
  };
  const beats = [...internal.performedBeats, performed];
  const next: InternalState = { ...internal, performedBeats: beats };

  if (res.verdict.shouldTerminate) {
    return finishRun(next, true, clock);
  }
  const nextIndex = pause.payload.beatIndex + 1;
  if (nextIndex >= internal.score.beats.length) {
    return finishRun(next, false, clock);
  }
  return enterPerformBeat(next, nextIndex, nid);
}

// ── State constructors ──────────────────────────────────────────────

function runningPause(internal: InternalState, pause: Pause): EngineState {
  return { kind: "running", pause, internal };
}

function failed(error: string): EngineState {
  return { kind: "failed", error };
}

function enterConfirmFit(
  internal: InternalState,
  summary: PatternSummary,
  nid: () => string,
): EngineState {
  const target = findPattern(internal.patterns, summary.pattern);
  if (!target) {
    return failed(`confirm-fit: pattern '${summary.pattern}' not registered`);
  }
  const next: InternalState = {
    ...internal,
    active: { patternName: target.score.pattern },
  };
  return runningPause(next, {
    kind: "confirm-fit",
    pauseId: nid(),
    payload: { pattern: summary.pattern, description: summary.description },
    composerPrompt: `Confirm pattern fit. '${summary.pattern}': ${summary.description}. ok?`,
    instrumentPrompt: `Reply ok=true to proceed, ok=false (with optional reroute) to reroute.`,
  });
}

function enterAfterConfirmFit(internal: InternalState, nid: () => string): EngineState {
  if (!internal.active) {
    return failed("after-confirm-fit: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("after-confirm-fit: active pattern not registered");
  }
  const required = activePattern.requiredContext;
  if (required.length === 0) {
    return enterGoGate(internal, nid);
  }
  const missing = required.filter((k) => !internal.context[k]);
  return runningPause(internal, makeElicitPause(activePattern, internal.context, missing, nid));
}

function enterDraftPatternRound(
  internal: InternalState,
  round: number,
  baseHint: Complexity,
  priorDraft: Pattern | undefined,
  nid: () => string,
): EngineState {
  const complexity = pickDebateComplexity(round, baseHint);
  const next: InternalState = { ...internal, draftRound: round };
  return runningPause(next, {
    kind: "draft-pattern-round",
    pauseId: nid(),
    payload: { round, maxRounds: DRAFT_MAX_ROUNDS, complexity, baseHint, priorDraft },
    composerPrompt: `Draft-pattern round ${round}/${DRAFT_MAX_ROUNDS} (complexity ${complexity}).`,
    instrumentPrompt: `Round ${round}; complexity ${complexity}. Spawn debate agents per tier.`,
  });
}

function enterClassifyComplexity(internal: InternalState, nid: () => string): EngineState {
  return runningPause(internal, {
    kind: "classify-complexity",
    pauseId: nid(),
    payload: { prompt: internal.prompt },
    composerPrompt: `Classify complexity (1-4) for: ${internal.prompt}`,
    instrumentPrompt: `Reply with complexity 1, 2, 3, or 4.`,
  });
}

function resolveClassifyComplexity(
  internal: InternalState,
  res: ClassifyRes,
  nid: () => string,
  events: OrchestratorEvent[],
): EngineState {
  if (![1, 2, 3, 4].includes(res.complexity)) {
    return failed(
      `classify-complexity: complexity must be 1|2|3|4 (got ${String(res.complexity)})`,
    );
  }
  events.push({ kind: "complexity-classified", complexity: res.complexity });
  return enterDraftPatternRound(internal, 1, res.complexity, undefined, nid);
}

function enterGoGate(internal: InternalState, nid: () => string): EngineState {
  if (!internal.active) {
    return failed("go-gate: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("go-gate: active pattern not registered");
  }
  return runningPause(internal, makeGoGatePause(activePattern, internal.context, nid));
}

function enterPerformBeat(
  internal: InternalState,
  beatIndex: number,
  nid: () => string,
): EngineState {
  if (!internal.score) {
    return failed("perform-beat: no compiled score");
  }
  const beat = internal.score.beats[beatIndex];
  if (!beat) {
    return failed(`perform-beat: out-of-range index ${beatIndex}`);
  }
  const previousOutputs = internal.performedBeats.map((b) => {
    const priorBeat = internal.score?.beats[b.beatIndex];
    return {
      beatIndex: b.beatIndex,
      directive: priorBeat?.directive ?? "",
      voices: b.voices.map((v) => ({ instrument: v.instrument, output: v.output })),
      verdictOutcome: b.verdict?.outcome ?? ("skipped" as const),
    };
  });
  return runningPause(internal, {
    kind: "perform-beat",
    pauseId: nid(),
    payload: { beatIndex, beat, previousOutputs },
    composerPrompt: `Perform beat ${beatIndex}: ${beat.directive}`,
    instrumentPrompt: `Beat ${beatIndex}: ${beat.directive}`,
  });
}

function finishRun(
  internal: InternalState,
  terminatedEarly: boolean,
  clock: () => string,
): EngineState {
  if (!internal.score) {
    return failed("finish-run: no compiled score");
  }
  if (!internal.active) {
    return failed("finish-run: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("finish-run: active pattern not registered");
  }
  const performance: Performance = {
    scoreId: internal.score.id,
    beats: internal.performedBeats,
    startedAt: internal.startedAt,
    completedAt: clock(),
    outcome: deriveOutcome(internal.performedBeats, terminatedEarly),
  };
  return {
    kind: "done",
    result: { executableScore: internal.score, performance, patternScore: activePattern.score },
  };
}

// ── Pause builders ──────────────────────────────────────────────────

function makeElicitPause(
  pattern: Pattern,
  collected: Readonly<Record<string, string>>,
  missingKeys: readonly string[],
  nid: () => string,
): Pause {
  return {
    kind: "elicit-context",
    pauseId: nid(),
    payload: { pattern: pattern.score.pattern, missingKeys, collected },
    composerPrompt: `Elicit context for '${pattern.score.pattern}'. Missing: [${missingKeys.join(", ")}]`,
    instrumentPrompt: `Reply with values for: ${missingKeys.join(", ")}`,
  };
}

function makeGoGatePause(
  pattern: Pattern,
  context: Readonly<Record<string, string>>,
  nid: () => string,
): Pause {
  return {
    kind: "go-gate",
    pauseId: nid(),
    payload: { pattern: pattern.score.pattern, context, beats: pattern.score.beats.length },
    composerPrompt: `Ready to compile '${pattern.score.pattern}' (${pattern.score.beats.length} beats). Say go.`,
    instrumentPrompt: `Send a canonical go phrase to advance.`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function findPattern(patterns: readonly Pattern[], name: string): Pattern | undefined {
  return patterns.find((p) => p.score.pattern === name);
}

function summaryOf(pattern: Pattern): PatternSummary {
  return { pattern: pattern.score.pattern, description: pattern.description };
}

function pickDebateComplexity(round: number, hint: Complexity): Complexity {
  const escalated = Math.min(4, hint + Math.max(0, round - 1)) as Complexity;
  return escalated;
}
