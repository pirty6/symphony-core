import { expect, test, type Page } from '@playwright/test'
import { approve, open, openSavedRun, startRun, waitForRunEnd } from './helpers'

const LONGER_THAN_DEFAULT_EXPECT_TIMEOUT_MS = 6_000

const waitAsLongAsASlowMachine = () => new Promise((resolve) => setTimeout(resolve, LONGER_THAN_DEFAULT_EXPECT_TIMEOUT_MS))

/** Holds every request to these paths back, as a slow machine would, before the server sees it. */
async function slowDown(page: Page, urlPattern: string) {
  await page.route(urlPattern, async (route) => {
    await waitAsLongAsASlowMachine()
    await route.continue()
  })
}

/**
 * The server sends a verdict with the saved run when a replay already finished. Here it never has:
 * the studio must ask for the verdict itself (GET /api/saved/check). The saved run is held back too.
 */
async function slowlyAnswerSavedRunsWithVerdictStillPending(page: Page) {
  await page.route('**/api/saved/file*', async (route) => {
    await waitAsLongAsASlowMachine()
    const response = await route.fetch()
    const savedRun = await response.json()
    await route.fulfill({ response, json: { ...savedRun, reproduced: null } })
  })
}

test('an approval answered slowly still clears its card', async ({ page }) => {
  await slowDown(page, '**/api/runs/*/approval')
  await open(page, 'hangman')
  await startRun(page)
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await approve(page, card, { field: 'letter', value: 'p' })
})

test('a saved run opens and verifies even when the server answers slowly', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, 'review')
  await page.getByText('auto-approve').click()
  await startRun(page)
  await waitForRunEnd(page)
  await slowlyAnswerSavedRunsWithVerdictStillPending(page)
  await slowDown(page, '**/api/saved/check*')
  const verdictAsked = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/saved/check')
  await page.getByTestId('toggle-demo-runs').click()
  const newestReview = page
    .getByTestId('saved-run')
    .filter({ has: page.locator('b', { hasText: /^review$/ }) })
    .first()
    .locator('.lib-item')
  await openSavedRun(page, newestReview)
  await verdictAsked
})
