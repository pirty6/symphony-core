/**
 * Classical repertoire: recorded answers indexed by (score, move, provider).
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
  find(scoreId: string, moveKey: string, provider: string): RecordedTake | undefined;
  readonly size: number;
}

const keyOf = (scoreId: string, moveKey: string, provider: string) =>
  `${scoreId}|${moveKey}|${provider}`;

export function repertoireFrom(runs: readonly { run: SavedRun; file: string }[]): Repertoire {
  const index = new Map<string, RecordedTake>();
  for (const { run, file } of runs) {
    for (const s of run.performance.steps) {
      if (s.kind !== 'agent' || !s.verdict || !s.transcript) continue;
      const key = keyOf(run.score.id, s.moveKey, s.transcript.provider);
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
    find: (scoreId, moveKey, provider) => index.get(keyOf(scoreId, moveKey, provider)),
    size: index.size,
  };
}
