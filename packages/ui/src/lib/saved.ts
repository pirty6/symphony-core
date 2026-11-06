import type { LiveRun, SavedSummary } from './api'

/** Statuses of a run that is still playing. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'paused', 'awaiting-approval'])

/** A saved checkpoint and its live run start within this of each other (publishing starts just before playing). */
const SAME_RUN_MS = 5 * 60 * 1000

/**
 * The saved runs to list: a run still playing is shown under "Running now" only, so its
 * checkpoint (outcome "in-progress", same score, started at the same time) is left out until it
 * ends. An in-progress checkpoint no live run plays is an interrupted run, kept so it can be resumed.
 */
export function savedToList(saved: readonly SavedSummary[], live: readonly LiveRun[]): SavedSummary[] {
  const playing = live.filter((run) => ACTIVE_STATUSES.has(run.status) && run.scoreId)
  if (!playing.length) return [...saved]
  return saved.filter(
    (entry) =>
      entry.outcome !== 'in-progress' ||
      !playing.some(
        (run) =>
          run.scoreId === entry.scoreId &&
          (!run.startedAt || Math.abs(Date.parse(run.startedAt) - Date.parse(entry.startedAt)) <= SAME_RUN_MS),
      ),
  )
}

/** Whether a run that was playing has stopped playing (or left the list), so the saved list changed. */
export function someRunEnded(before: readonly LiveRun[], after: readonly LiveRun[]): boolean {
  const still = new Set(after.filter((run) => ACTIVE_STATUSES.has(run.status)).map((run) => run.id))
  return before.some((run) => ACTIVE_STATUSES.has(run.status) && !still.has(run.id))
}
