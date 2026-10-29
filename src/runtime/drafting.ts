/**
 * Draft loop: ask a provider for a pattern, validate it strictly, feed the
 * errors back, and stop after `maxRounds`. Nothing runs until a human
 * approves the returned draft.
 */
import { draftInstructions, parseDraft } from '../core/draft.js';
import type { AiTranscript, Pattern } from '../core/types.js';
import type { Provider, ProviderEvent } from './provider.js';

export interface DraftRound {
  readonly round: number;
  readonly raw: unknown;
  readonly errors: readonly string[];
  readonly transcript: AiTranscript;
}

export interface DraftOutcome {
  readonly pattern?: Pattern;
  readonly rounds: readonly DraftRound[];
}

export async function draftPattern(
  provider: Provider,
  request: string,
  opts: {
    readonly maxRounds?: number;
    readonly priorDraft?: unknown;
    readonly feedback?: readonly string[];
    readonly signal?: AbortSignal;
    readonly onEvent?: (e: ProviderEvent & { round: number }) => void;
  } = {},
): Promise<DraftOutcome> {
  const rounds: DraftRound[] = [];
  const max = opts.maxRounds ?? 3;
  let prior = opts.priorDraft;
  let feedback = opts.feedback;
  for (let round = 1; round <= max; round += 1) {
    const res = await provider.draft({
      request,
      instructions: draftInstructions(),
      ...(prior !== undefined ? { priorDraft: prior } : {}),
      ...(feedback ? { feedback } : {}),
      signal: opts.signal ?? new AbortController().signal,
      onEvent: (e) => opts.onEvent?.({ ...e, round }),
    });
    const parsed = parseDraft(res.result);
    rounds.push({
      round,
      raw: res.result,
      errors: parsed.ok ? [] : parsed.errors,
      transcript: res.transcript,
    });
    if (parsed.ok) return { pattern: parsed.value, rounds };
    prior = res.result;
    feedback = parsed.errors;
  }
  return { rounds };
}
