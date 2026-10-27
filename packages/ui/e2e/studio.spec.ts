import { expect, test, type Page } from '@playwright/test'

async function open(page: Page, pattern: string) {
  await page.goto(`/#${pattern}`)
  await expect(page.locator('.tb-title')).toContainText(pattern)
  await expect(page.getByText(/Valid: every path is bounded/)).toBeVisible()
}

async function guess(page: Page, letter: string) {
  const card = page.getByTestId('approval-card')
  const pauseId = await card.getAttribute('data-pause-id')
  await card.getByLabel('letter', { exact: true }).fill(letter)
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.locator(`[data-pause-id="${pauseId}"]`)).toHaveCount(0)
}

test('plays hangman live: AI picks, human guesses, engine scores', async ({ page }) => {
  await open(page, 'hangman')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('node-ask')).toHaveAttribute('data-status', 'paused')
  for (const l of ['p', 'l', 'a', 'n', 'e', 't']) {
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await guess(page, l)
  }
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await expect(page.getByTestId('node-win')).toHaveAttribute('data-status', 'done')
  await page.getByRole('button', { name: 'State' }).click()
  await expect(page.getByTestId('state-won')).toContainText('true')
})

test('step mode halts before and after the AI; the proposed result is visible before it is applied', async ({ page }) => {
  await open(page, 'fix')
  await page.getByText('auto-approve').click()
  await page.getByLabel('step mode').check()
  await page.getByRole('button', { name: '▶ Run' }).click()
  const gate = page.getByTestId('gate-card')
  await expect(gate).toContainText('Paused before “diagnose”')
  await gate.getByRole('button', { name: '⏭ Step' }).click()
  await expect(gate).toContainText('after AI answered')
  await expect(page.getByTestId('proposed-result')).toContainText('src/paginate.ts')
  await page.getByLabel('step mode').uncheck()
  await gate.getByRole('button', { name: '▶ Resume' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await expect(page.getByTestId('run-result')).toContainText("reached end 'fixed'")
})

test('saved runs replay and verify deterministically', async ({ page }) => {
  await open(page, 'review')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await page.locator('.lib-item.saved').first().click()
  await expect(page.getByTestId('replay-check')).toContainText('reproduces this run exactly')
  await page.getByLabel('timeline').fill('5')
  await expect(page.getByTestId('timeline-events').locator('li.current')).toBeVisible()
})

test('AI drafts a flow onto the canvas', async ({ page }) => {
  await open(page, 'investigate')
  await page.getByLabel('draft request').fill('Bump dependencies and keep tests green')
  await page.getByRole('button', { name: '✨ Draft flow' }).click()
  await expect(page.locator('.tb-title')).toContainText('bump-dependencies-and-keep')
  await expect(page.locator('.react-flow__node')).toHaveCount(10)
  await page.getByRole('button', { name: 'View TypeScript' }).click()
  await expect(page.locator('.ts-output')).toContainText('export const bumpDependenciesAndKeep: Pattern')
})
