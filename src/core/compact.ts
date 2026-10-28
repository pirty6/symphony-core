/**
 * Retention for old runs. Most of a saved run is history that replay can rebuild
 * (events, each step's changes and input); the rest is the AI's raw text. Compacting
 * keeps every recorded answer, hash and decision, plus who answered and the tokens
 * used, so a compacted run still replays, verifies and feeds the repertoire.
 */
import { replayPerformance } from './replay.js';
import type { AiTranscript, ExecutableScore, Performance, PerformedStep } from './types.js';

/** A transcript without the text: identity and usage only. */
function slim(t: AiTranscript): AiTranscript {
  return {
    provider: t.provider,
    ...(t.model ? { model: t.model } : {}),
    prompt: '',
    output: '',
    toolCalls: [],
    ...(t.startedAt ? { startedAt: t.startedAt } : {}),
    ...(t.completedAt ? { completedAt: t.completedAt } : {}),
    ...(t.takes ? { takes: t.takes.map(slim) } : {}),
    ...(t.fromRepertoire ? { fromRepertoire: t.fromRepertoire } : {}),
    ...(t.musician ? { musician: t.musician } : {}),
    ...(t.usage ? { usage: t.usage } : {}),
  };
}

type Attempt = NonNullable<PerformedStep['attempts']>[number];

function compactAttempt({ transcript, ...a }: Attempt): Attempt {
  return transcript ? { ...a, transcript: slim(transcript) } : a;
}

function compactStep(s: PerformedStep): PerformedStep {
  const { changes: _changes, input: _input, transcript, attempts, ...rest } = s;
  return {
    ...rest,
    changes: [],
    ...(transcript ? { transcript: slim(transcript) } : {}),
    ...(attempts
      ? {
          attempts: attempts.map(compactAttempt),
        }
      : {}),
  };
}

/**
 * The compacted run, or undefined when it cannot be compacted safely: it must still
 * reproduce exactly by replay, or the dropped history could not be rebuilt.
 */
export function compactPerformance(
  score: ExecutableScore,
  perf: Performance,
): Performance | undefined {
  if (perf.compacted) return perf;
  if (!replayPerformance(score, perf).divergence.reproduced) return undefined;
  return { ...perf, steps: perf.steps.map(compactStep), events: [], compacted: true };
}

/** Rebuild a compacted run's events, changes and inputs by replaying its answers. */
export function expandPerformance(score: ExecutableScore, perf: Performance): Performance {
  if (!perf.compacted) return perf;
  const { result, divergence } = replayPerformance(score, perf);
  if (!divergence.reproduced) return perf;
  return { ...perf, steps: result.state.steps, events: result.state.events };
}
