import { describe, expect, it } from 'vitest'
import type { LiveRun, SavedSummary } from './api'
import { runHover, savedToList, someRunEnded } from './saved'

const saved = (file: string, more: Partial<SavedSummary> = {}): SavedSummary => ({
  file,
  pattern: 'review',
  goal: 'PR 1',
  scoreId: 'score-a',
  outcome: 'in-progress',
  startedAt: '2026-11-06T18:00:02Z',
  steps: 3,
  ...more,
})
const live = (id: string, more: Partial<LiveRun> = {}): LiveRun => ({
  id,
  pattern: 'review',
  goal: 'PR 1',
  status: 'running',
  scoreId: 'score-a',
  startedAt: '2026-11-06T18:00:00Z',
  ...more,
})

describe('saved runs list', () => {
  it('leaves out the checkpoint of a run still playing, and lists it once it ends', () => {
    const playing = saved('review/now.json')
    const finished = saved('review/old.json', { outcome: 'success', startedAt: '2026-11-05T10:00:00Z' })
    expect(savedToList([playing, finished], [live('r1')])).toEqual([finished])
    expect(savedToList([{ ...playing, outcome: 'success' }, finished], [live('r1', { status: 'done' })])).toHaveLength(2)
  })

  it('keeps an interrupted run of the same score, started at another time, so it can be resumed', () => {
    const interrupted = saved('review/interrupted.json', { startedAt: '2026-11-05T10:00:00Z' })
    expect(savedToList([interrupted], [live('r1')])).toEqual([interrupted])
  })

  it('keeps checkpoints of other scores, and every run when nothing plays', () => {
    const other = saved('fix/other.json', { scoreId: 'score-b' })
    expect(savedToList([other], [live('r1')])).toEqual([other])
    expect(savedToList([saved('review/now.json')], [])).toHaveLength(1)
  })

  it('notices when a playing run ends or leaves the list', () => {
    expect(someRunEnded([live('r1')], [live('r1', { status: 'done' })])).toBe(true)
    expect(someRunEnded([live('r1')], [])).toBe(true)
    expect(someRunEnded([live('r1')], [live('r1'), live('r2')])).toBe(false)
    expect(someRunEnded([live('r1', { status: 'done' })], [])).toBe(false)
  })
})

describe('runHover', () => {
  it("names a running run first (e.g. the PR's title), then what it was asked and who plays it", () => {
    const url = 'https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/5997156'
    expect(runHover({ goal: url, title: 'PR 5997156: Add hourly schedules', source: 'cli', workspace: '/w' })).toBe(
      `PR 5997156: Add hourly schedules\n${url}\n\nPlayed by the symphony CLI in /w: you can watch it and answer it here.`,
    )
    expect(runHover({ goal: url })).toBe(url)
    expect(runHover({ goal: 'g', title: 'g' })).toBe('g')
  })
})
