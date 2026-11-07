import { expect, type Locator, type Page } from '@playwright/test'

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

const isPostTo = (route: RegExp) => (response: { url(): string; request(): { method(): string } }) =>
  response.request().method() === 'POST' && route.test(new URL(response.url()).pathname)

const isApprovalAnswer = isPostTo(/^\/api\/runs\/[^/]+\/approval$/)
const isControlCommand = isPostTo(/^\/api\/runs\/[^/]+\/control$/)

async function expectCardDropped(page: Page, pauseId: string | null) {
  await page.locator(`[data-pause-id="${pauseId}"]`).waitFor({ state: 'detached' })
  await expect(page.locator(`[data-pause-id="${pauseId}"]`)).toHaveCount(0)
}

/** Turns auto-approve on while a card waits: the server answers the card itself, and the studio then drops it. */
export async function autoApproveWaitingCard(page: Page, card: Locator) {
  const pauseId = await card.getAttribute('data-pause-id')
  const autoApprove = page.getByLabel('auto-approve')
  await expect(autoApprove).toBeEnabled()
  const sent = page.waitForResponse(isControlCommand)
  await autoApprove.check()
  expect((await sent).ok(), 'the server accepted auto-approve').toBe(true)
  await expectCardDropped(page, pauseId)
}

/**
 * Answers an approval card and waits until the studio has dropped it. Only the run's event stream
 * (a separate connection from the answer) removes the card, so it may be slow on a busy machine:
 * wait for as long as the test may, not the short assertion timeout, and say what went wrong if it did.
 */
export async function approve(page: Page, card: Locator, answer?: { field: string; value: string }) {
  const pauseId = await card.getAttribute('data-pause-id')
  const answered = page.waitForResponse(isApprovalAnswer)
  if (answer) await card.getByLabel(answer.field, { exact: true }).fill(answer.value)
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  expect((await answered).ok(), 'the server accepted the approval').toBe(true)
  await expectCardDropped(page, pauseId)
}

/** Waits for the run to end (its last status arrives on the event stream), then checks how it ended. */
export async function waitForRunEnd(page: Page, expected: 'done' | 'failed' | 'cancelled' = 'done') {
  const status = page.getByTestId('run-status')
  await status.filter({ hasText: /^(done|failed|cancelled)$/ }).waitFor()
  await expect(status).toHaveText(expected)
}

/** Opens a saved run and waits for the server's answers: the run itself, then the replay verdict. */
export async function openSavedRun(page: Page, row: Locator) {
  const answered = page.waitForResponse(
    (response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/saved/file',
  )
  await row.click()
  expect((await answered).ok(), 'the server sent the saved run').toBe(true)
  const replayCheck = page.getByTestId('replay-check')
  // The verdict comes from a second request, and a long replay takes a while: wait for it as long as the test may.
  await replayCheck.filter({ hasNotText: '⏳' }).waitFor()
  await expect(replayCheck).toContainText('reproduces this run exactly')
}
