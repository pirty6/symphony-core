import { expect, test, type Page } from '@playwright/test'
import { open } from './helpers'

const LONGER_THAN_DEFAULT_EXPECT_TIMEOUT_MS = 6_000

const title = (page: Page) => page.locator('.tb-title')

test('opens the hash pattern once the library arrives late', async ({ page }) => {
  let releaseLibrary!: () => void
  const libraryHeld = new Promise<void>((resolve) => (releaseLibrary = resolve))
  await page.route('**/api/patterns*', async (route) => {
    await libraryHeld
    await route.continue()
  })
  await page.goto('/#hangman')
  await expect(title(page)).toContainText('my-flow')
  releaseLibrary()
  await expect(title(page)).toContainText('hangman')
  await expect(page.getByText(/Valid: every path is bounded/)).toBeVisible()
})

test('open waits for the active library request, not the cancelled first one', async ({ page }) => {
  let releaseLibrary!: () => void
  const libraryHeld = new Promise<void>((resolve) => (releaseLibrary = resolve))
  let requests = 0
  await page.route('**/api/patterns*', async (route) => {
    requests += 1
    if (requests > 1) await libraryHeld
    await route.continue()
  })
  let opened = false
  const opening = open(page, 'hangman').then(() => (opened = true))
  await expect.poll(() => requests).toBeGreaterThan(1)
  await expect(title(page)).toContainText('my-flow')
  await page.waitForTimeout(LONGER_THAN_DEFAULT_EXPECT_TIMEOUT_MS)
  expect(opened).toBe(false)
  await expect(title(page)).toContainText('my-flow')
  releaseLibrary()
  await opening
  await expect(title(page)).toContainText('hangman')
})

test('open reports a library that fails to load, instead of timing out on the title', async ({ page }) => {
  await page.route('**/api/patterns*', (route) => route.fulfill({ status: 500, body: 'library is down' }))
  await expect(open(page, 'hangman')).rejects.toThrow(/Could not load patterns/)
})
