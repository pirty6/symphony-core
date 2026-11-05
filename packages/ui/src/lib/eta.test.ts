import { describe, expect, it } from 'vitest'
import { elapsed, estimateMs, etaLabel, formatDuration, type PastRun } from './eta'

const T0 = Date.parse('2026-01-01T00:00:00Z')
const past = (durationMs: number | null, more: Partial<PastRun> = {}): PastRun => ({ pattern: 'fix', outcome: 'success', durationMs, ...more })

describe('run timer and estimate', () => {
  it('times a run from its start, leaving out the waits for a person', () => {
    expect(elapsed({}, T0)).toBeUndefined()
    expect(elapsed({ startedAt: '2026-01-01T00:00:00Z' }, T0 + 192_000)).toEqual({ totalMs: 192_000, activeMs: 192_000 })
    // 30s answered already, and waiting now for 12s more.
    expect(
      elapsed({ startedAt: '2026-01-01T00:00:00Z', waitMs: 30_000, waitingSince: '2026-01-01T00:03:00Z' }, T0 + 192_000),
    ).toEqual({ totalMs: 192_000, activeMs: 150_000 })
  })

  it('estimates from the median of recent successful runs of the pattern, waits left out', () => {
    expect(estimateMs([], 'fix')).toBeUndefined()
    const history = [
      past(120_000),
      past(300_000, { waitMs: 60_000 }),
      past(180_000),
      past(10_000, { outcome: 'failed' }),
      past(null),
      past(1_000, { demo: true }),
      past(999_000, { pattern: 'review' }),
    ]
    expect(estimateMs(history, 'fix')).toBe(180_000)
    expect(estimateMs([past(100_000), past(200_000)], 'fix')).toBe(150_000)
    // Demo runs estimate demo runs only.
    expect(estimateMs(history, 'fix', true)).toBe(1_000)
    expect(estimateMs(history, 'investigate')).toBeUndefined()
  })

  it('counts only the most recent runs', () => {
    const old = Array.from({ length: 30 }, () => past(900_000))
    expect(estimateMs([...Array.from({ length: 20 }, () => past(60_000)), ...old], 'fix')).toBe(60_000)
  })

  it('formats elapsed time and what is left', () => {
    expect(formatDuration(45_400)).toBe('45s')
    expect(formatDuration(192_000)).toBe('3m 12s')
    expect(formatDuration(3_840_000)).toBe('1h 04m')
    expect(etaLabel(undefined, 0)).toBeUndefined()
    expect(etaLabel(240_000, 0)).toBe('~4m left')
    expect(etaLabel(240_000, 1_000)).toBe('~4m left')
    expect(etaLabel(60_000, 20_500)).toBe('~40s left')
    expect(etaLabel(7_200_000, 0)).toBe('~2h 00m left')
    expect(etaLabel(60_000, 60_000)).toBe('taking longer than usual')
  })
})
