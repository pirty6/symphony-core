import { useEffect, useState } from 'react'
import type { LiveRun } from '../lib/api'
import { elapsed, estimateMs, etaLabel, formatDuration, type PastRun } from '../lib/eta'

/** The time now, again every `ms`. */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** "⏱ 3m 12s · ~4m left": how long a playing run has taken, ticking, and about how long it has left. */
export function RunTimer({ run, history }: { run: LiveRun; history: readonly PastRun[] }) {
  const now = useNow()
  const time = elapsed(run, now)
  if (!time) return null
  const estimate = estimateMs(history, run.pattern, run.demo)
  const eta = etaLabel(estimate, time.activeMs)
  const waited = time.totalMs - time.activeMs
  const title = [
    `Playing for ${formatDuration(time.totalMs)}${waited >= 1000 ? `, ${formatDuration(waited)} of it waiting for a person` : ''}.`,
    estimate === undefined
      ? `No finished ${run.pattern} run to estimate from yet.`
      : `Usually takes ${formatDuration(estimate)} (the median of its recent successful runs, waits for a person left out).`,
  ].join('\n')
  return (
    <span className="run-timer" data-testid="run-timer" title={title}>
      ⏱ {formatDuration(time.totalMs)}
      {eta && (
        <span className={estimate! <= time.activeMs ? 'over' : undefined} data-testid="run-eta">
          {' '}
          · {eta}
        </span>
      )}
    </span>
  )
}
