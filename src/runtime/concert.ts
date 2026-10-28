/**
 * Concert: the maestro composes a score, then the orchestra performs it.
 * `concertNext` is the `next` hook for a maestro Run: it compiles the composed
 * score and starts it as its own (linked, separately recorded) run.
 */
import { CompileError } from '../core/compile.js';
import type { ExecutableScore, Improvisation, Pattern, Performance } from '../core/types.js';
import { composedScore, maestroThen } from '../patterns/maestro.js';
import type { NextPerformance } from './driver.js';

export function concertNext(opts: {
  readonly maestroScore: ExecutableScore;
  readonly improvisation?: Improvisation;
  /** Start the composed score, then the patterns to chain after it; returns the new run id. */
  readonly start: (
    score: ExecutableScore,
    pattern: Pattern,
    then: readonly string[],
  ) => Promise<string>;
}): ((performance: Performance) => Promise<NextPerformance | undefined>) | undefined {
  if (opts.maestroScore.pattern !== 'maestro') return undefined;
  return async (performance) => {
    const state = performance.finalState;
    let composed: ReturnType<typeof composedScore>;
    try {
      composed = composedScore(
        opts.maestroScore,
        state,
        opts.improvisation === undefined ? {} : { improvisation: opts.improvisation },
      );
    } catch (e) {
      const finalPattern = state.finalPattern as Pattern | undefined;
      if (!finalPattern || !(e instanceof CompileError)) throw e;
      return {
        pattern: finalPattern,
        context: (state.childContext as Record<string, unknown>) ?? {},
        error: `The score is ready but needs inputs before it can play: ${e.issues.map((i) => i.message).join('; ')}`,
      };
    }
    if (!composed) return undefined;
    const runId = await opts.start(composed.score, composed.pattern, maestroThen(state));
    return { pattern: composed.pattern, context: composed.score.context, runId };
  };
}
