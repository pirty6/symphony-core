/**
 * Classical repertoire: recorded answers indexed by (score, move, provider, model
 * settings). An answer recorded with one model or reasoning effort is not replayed
 * for a run that asks for another: the notes depend on the musician.
 *
 * A move is (moveType, targetSite, stateHash) and the stateHash covers the run
 * state and the workspace fingerprint, so an entry is only reused when the same
 * song is played from exactly the same position: the same notes come back.
 */
import type { AiTranscript, SavedRun } from '../core/types.js';

export interface RecordedTake {
  readonly result: unknown;
  readonly transcript?: AiTranscript;
  /** Saved run the notes come from. */
  readonly file: string;
}

export interface Repertoire {
  /** `settings`: the model and effort the step asks for ('' when the provider has none). */
  find(
    scoreId: string,
    moveKey: string,
    provider: string,
    settings?: string,
  ): RecordedTake | undefined;
  readonly size: number;
}

const keyOf = (scoreId: string, moveKey: string, provider: string, settings: string) =>
  `${scoreId}|${moveKey}|${provider}|${settings}`;

/** "model/effort" as asked for, as recorded with the answer ('' when there was none). */
export function settingsOf(t: AiTranscript): string {
  // Providers that record no musician (scripted) have no settings; Copilot always does.
  const m = t.musician;
  return m ? modelSettings(m.requestedModel, m.effort) : '';
}

export const modelSettings = (model: string | undefined, effort: string | undefined): string =>
  `${model ?? 'default'}${effort ? `/${effort}` : ''}`;

export function repertoireFrom(runs: readonly { run: SavedRun; file: string }[]): Repertoire {
  const index = new Map<string, RecordedTake>();
  for (const { run, file } of runs) {
    for (const s of run.performance.steps) {
      if (s.kind !== 'agent' || !s.verdict || !s.transcript) continue;
      const key = keyOf(run.score.id, s.moveKey, s.transcript.provider, settingsOf(s.transcript));
      if (index.has(key)) continue;
      index.set(key, {
        result: {
          updates: s.updates ?? {},
          verdict: s.verdict,
          ...(s.next ? { next: s.next } : {}),
        },
        transcript: s.transcript,
        file,
      });
    }
  }
  return {
    find: (scoreId, moveKey, provider, settings = '') =>
      index.get(keyOf(scoreId, moveKey, provider, settings)),
    size: index.size,
  };
}
