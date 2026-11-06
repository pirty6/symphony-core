import { expect, type Page } from '@playwright/test'

/** Opens a pattern from the URL hash and waits until the studio shows it (or says it could not load the library). */
export async function open(page: Page, pattern: string) {
  await page.goto(`/#${pattern}`)
  const title = page.locator('.tb-title').filter({ hasText: pattern })
  const loadError = page.getByText(/Could not load patterns/)
  // The library answering is what opens the pattern, and it may be slow on a busy machine: wait for it
  // for as long as the test may (not the short assertion timeout), then check what the studio shows.
  await title.or(loadError).waitFor()
  if (await loadError.isVisible()) throw new Error(`Opening "${pattern}" failed: ${await loadError.innerText()}`)
  await expect(page.locator('.tb-title')).toContainText(pattern)
  await expect(page.getByText(/Valid: every path is bounded/)).toBeVisible()
}

/** Clicks ▶ Run and waits for the server to accept the run, so later waits start from a run that exists. */
export async function startRun(page: Page) {
  const accepted = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs',
  )
  await page.getByRole('button', { name: '▶ Run' }).click()
  expect((await accepted).ok()).toBe(true)
}
