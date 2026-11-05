/**
 * How long a run has played, and about how long it has left: estimated from the past
 * runs of the same pattern. Pure, so the sidebar and the toolbar tell the same time.
 */

/** What a playing run says about its time (GET /api/runs). */
export interface RunClock {
  readonly startedAt?: string
  readonly waitMs?: number
  readonly waitingSince?: string
}

/** What a saved run says about its time (GET /api/saved). */
export interface PastRun {
  readonly pattern: string
  readonly outcome: string
  readonly durationMs?: number | null
  readonly waitMs?: number
  readonly demo?: boolean
}

/** Only the most recent runs count: patterns and models change. */
const RECENT = 20

/** Wall time since it started, and of that the time it played (not waiting for a person). */
export function elapsed(run: RunClock, now: number): { readonly totalMs: number; readonly activeMs: number } | undefined {
  const start = Date.parse(run.startedAt ?? '')
  if (!Number.isFinite(start)) return undefined
  const totalMs = Math.max(0, now - start)
  const since = Date.parse(run.waitingSince ?? '')
  const waitingNow = Number.isFinite(since) ? Math.max(0, now - since) : 0
  return { totalMs, activeMs: Math.max(0, totalMs - (run.waitMs ?? 0) - waitingNow) }
}

/**
 * The median time the recent successful runs of this pattern played, waits for a person left
 * out; demo runs only estimate demo runs. Undefined with no such run to go by.
 */
export function estimateMs(history: readonly PastRun[], pattern: string, demo = false): number | undefined {
  const times = history
    .filter((r) => r.pattern === pattern && r.outcome === 'success' && (r.demo ?? false) === demo && typeof r.durationMs === 'number')
    .slice(0, RECENT)
    .map((r) => Math.max(0, r.durationMs! - (r.waitMs ?? 0)))
    .toSorted((a, b) => a - b)
  if (times.length === 0) return undefined
  const mid = Math.floor(times.length / 2)
  return times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2
}

/** "45s", "3m 12s", "1h 04m". */
export function formatDuration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** "~4m left" (rounded up, to the second under a minute), or past the estimate, so. */
export function etaLabel(estimate: number | undefined, activeMs: number): string | undefined {
  if (estimate === undefined) return undefined
  const left = estimate - activeMs
  if (left <= 0) return 'taking longer than usual'
  if (left < 60_000) return `~${Math.ceil(left / 1000)}s left`
  const m = Math.ceil(left / 60_000)
  return `~${m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`} left`
}
