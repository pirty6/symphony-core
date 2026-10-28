/**
 * Runtime side of chaining: a `next` hook that, when a run succeeds, compiles
 * the next pattern of the chain with the handed-over inputs and starts it.
 * The started run gets the rest of the chain, so chains of any length work.
 */
import { handoffContext } from '../core/chain.js';
import { compileScore, CompileError } from '../core/compile.js';
import type {
  Complexity,
  ExecutableScore,
  Improvisation,
  Pattern,
  Performance,
} from '../core/types.js';
import type { NextPerformance } from './driver.js';

export interface ChainOptions {
  /** Pattern names to play after this run, in order. */
  readonly chain: readonly string[];
  readonly score: ExecutableScore;
  readonly library: () => Promise<readonly Pattern[]>;
  /** Inputs given for each next pattern by name (e.g. its test command). */
  readonly inputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly complexity?: Complexity;
  readonly improvisation?: Improvisation;
  /** Start a compiled score with the rest of the chain; returns the new run id. */
  readonly start: (
    score: ExecutableScore,
    pattern: Pattern,
    chain: readonly string[],
  ) => Promise<string>;
}

export function chainNext(
  opts: ChainOptions,
): ((performance: Performance) => Promise<NextPerformance | undefined>) | undefined {
  const [name, ...rest] = opts.chain;
  if (!name) return undefined;
  return async (performance) => {
    const pattern = (await opts.library()).find((p) => p.name === name);
    if (!pattern) throw new Error(`chain: unknown pattern '${name}'`);
    const context = handoffContext(
      pattern,
      { score: opts.score, performance },
      opts.inputs?.[name],
    );
    let score: ExecutableScore;
    try {
      score = compileScore(pattern, {
        goal: opts.score.goal,
        context,
        ...(opts.complexity ? { complexity: opts.complexity } : {}),
        ...(opts.improvisation !== undefined ? { improvisation: opts.improvisation } : {}),
      });
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      return {
        pattern,
        context,
        error: `'${name}' needs inputs before it can play: ${e.issues.map((i) => i.message).join('; ')}`,
      };
    }
    const runId = await opts.start(score, pattern, rest);
    return { pattern, context: score.context, runId };
  };
}
