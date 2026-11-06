import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ListedRun {
  id: string
  source?: string
}

const configuredLiveDir = () => {
  const dir = process.env.SYMPHONY_E2E_LIVE_DIR
  if (!dir) throw new Error('playwright.config.ts did not set SYMPHONY_E2E_LIVE_DIR')
  return dir
}

/** The folder the studio would read if it were not isolated. */
const machineLiveDir = () => join(homedir(), '.symphony', 'live')

/** A chat run that another process published and that ended: meta.json is all the studio needs to list it. */
function publishLiveRun(liveDir: string, id: string) {
  const dir = join(liveDir, id)
  mkdirSync(dir, { recursive: true })
  const score = { id, pattern: 'hangman', goal: 'a run from another process', nodes: [], edges: [] }
  const meta = { id, pattern: 'hangman', goal: score.goal, source: 'chat', workspace: '/elsewhere', pid: 2 ** 22 + 12345, startedAt: new Date().toISOString(), score }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
  return () => rmSync(dir, { recursive: true, force: true })
}

async function listedRunIds(page: Page) {
  const response = await page.request.get('/api/runs')
  expect(response.ok()).toBe(true)
  return ((await response.json()) as ListedRun[]).map((run) => run.id)
}

test('the studio lists the runs published in its own live folder, not the machine\'s', async ({ page }) => {
  const unique = `${Date.now()}-${process.pid}`
  const insideId = `e2e-inside-${unique}`
  const outsideId = `e2e-outside-${unique}`
  const removeInside = publishLiveRun(configuredLiveDir(), insideId)
  const removeOutside = publishLiveRun(machineLiveDir(), outsideId)
  try {
    const listed = await listedRunIds(page)
    expect(listed).toContain(insideId)
    expect(listed).not.toContain(outsideId)
  } finally {
    removeInside()
    removeOutside()
  }
})
