import { expect, test, type Page } from '@playwright/test'
import { investigate } from '../../../src/patterns/investigate'

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
  await expect(gate).toContainText('Paused before “hypothesize”')
  await gate.getByRole('button', { name: '⏭ Step' }).click()
  await expect(gate).toContainText('after AI answered')
  await expect(page.getByTestId('proposed-result')).toContainText('H1: paginate slices from start - 1')
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

test('the maestro composes a score, then the orchestra performs it', async ({ page }) => {
  await open(page, 'investigate')
  await page.getByLabel('maestro request').fill('Fix the flaky login test that fails on CI')
  await page.getByRole('button', { name: '🎼 Compose & perform' }).click()
  await expect(page.locator('.tb-title')).toContainText('maestro')
  await expect(page.getByTestId('composed-score')).toContainText('fix · complexity 3')
  await page.getByTestId('approval-card').getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('notice')).toContainText("composed 'fix' (complexity 3)")
  await expect(page.locator('.tb-title')).toContainText('fix')
  await page.getByTestId('approval-card').getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('run-result')).toContainText("reached end 'fixed'")
})

test('bebop plays takes that a bandleader merges', async ({ page }) => {
  await open(page, 'review')
  await page.getByLabel('improvisation').fill('3')
  await expect(page.locator('.knob-name')).toHaveText('Bebop')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await page.getByLabel('follow active node').uncheck()
  await page.getByRole('button', { name: 'Fit View' }).click()
  await page.getByTestId('node-collect').click()
  await page.getByRole('button', { name: 'AI output' }).click()
  await expect(page.getByTestId('ai-takes').locator('summary')).toHaveText(['Take 1', 'Take 2', '🎺 Bandleader: merged answer'])
  await expect(page.getByTestId('origin-summary')).toContainText('with takes')
  await expect(page.getByTestId('origin-collect')).toHaveText('📜 scripted')
})

test('phases collapse into one node, light up while running and open into their steps', async ({ page }) => {
  await open(page, 'investigate')
  await expect(page.getByTestId('node-inventory')).toHaveCount(0)
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await expect(page.getByTestId('result-reader')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('phase-deepPhase')).toHaveAttribute('data-status', 'done')
  await page.getByRole('button', { name: 'open phase listPhase' }).dispatchEvent('click')
  await expect(page.getByTestId('frame-listPhase')).toBeVisible()
  await expect(page.getByTestId('node-inventory')).toHaveAttribute('data-status', 'done')
  await page.getByRole('button', { name: 'close phase listPhase' }).dispatchEvent('click')
  await expect(page.getByTestId('node-inventory')).toHaveCount(0)
  await page.getByTestId('toggle-phases').click()
  await expect(page.locator('.phase-frame')).toHaveCount(investigate.groups!.length)
})

test('the result opens in a reader when a run ends', async ({ page }) => {
  await open(page, 'investigate')
  await page.getByRole('button', { name: '▶ Run' }).click()
  const reader = page.getByTestId('result-reader')
  await expect(reader).toBeVisible()
  await expect(reader.getByRole('heading', { level: 2 })).toContainText('offline demo (canned answers)')
  await expect(reader.getByTestId('result-answer')).toContainText(/\S/)
  await expect(reader.getByRole('dialog')).toHaveAttribute('aria-label', 'run result')
  await page.keyboard.press('Escape')
  await expect(reader).toHaveCount(0)
  await expect(page.getByTestId('result-preview')).toContainText('answer')
  await page.getByRole('button', { name: '⤢ Read full result' }).click()
  await expect(reader).toBeVisible()
  await reader.getByRole('button', { name: 'close result' }).click()
  await expect(reader).toHaveCount(0)
})

test('a saved run can be forked from the step shown on the timeline', async ({ page }) => {
  await open(page, 'review')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await page.locator('.lib-item.saved').first().click()
  await expect(page.getByTestId('replay-check')).toContainText('reproduces this run exactly')
  await page.getByLabel('timeline').fill('6')
  const fork = page.getByTestId('fork')
  await expect(fork).toHaveText(/⑂ Fork from step \d+/)
  const step = Number((await fork.textContent())!.match(/\d+/)![0])
  await fork.click()
  await expect(page.getByTestId('notice')).toContainText(`Forked at step ${step}`)
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await expect(page.getByTestId('based-on')).toContainText(`forked from`)
  await expect(page.getByTestId('based-on')).toContainText(`after step ${step - 1}`)
})

test('warns before the offline demo ignores your own question, and remembers the AI choice', async ({ page }) => {
  await open(page, 'investigate')
  await expect(page.getByTestId('demo-warning')).toHaveCount(0)
  await page.getByLabel('context question').fill('Is the fix pattern good enough?')
  await expect(page.getByTestId('demo-warning')).toContainText('ignore your question')
  await page.getByTestId('demo-warning').getByRole('button', { name: 'Use Copilot' }).click()
  await expect(page.getByTestId('demo-warning')).toHaveCount(0)
  await expect(page.getByLabel('provider')).toHaveValue('copilot')
  await page.reload()
  await expect(page.getByLabel('provider')).toHaveValue('copilot')
})

test('a stuck AI step waits for you: retry with a hint and a smarter tier, then stop', async ({ page }) => {
  // Make 'pick' impossible to satisfy, so every attempt is rejected and the step gets stuck.
  await page.route('**/api/runs', async (route) => {
    const body = route.request().postDataJSON() as { pattern: { nodes: { id: string; checks?: unknown[] }[] } }
    for (const n of body.pattern.nodes) {
      if (n.id === 'pick') n.checks = [{ expr: 'len(word) > 99', message: 'The word must be over 99 letters.' }]
    }
    await route.continue({ postData: JSON.stringify(body) })
  })
  await open(page, 'hangman')
  await page.getByRole('button', { name: '▶ Run' }).click()
  const card = page.getByTestId('recovery-card')
  await expect(card).toContainText('Pick word is stuck')
  await expect(card).toContainText('The word must be over 99 letters.')
  await card.getByLabel('recovery hint').fill('use a much longer word')
  await card.getByLabel('recovery tier').selectOption('4')
  await card.getByRole('button', { name: '↻ Retry step' }).click()
  await expect(page.getByTestId('timeline-events')).toContainText('pick: retry at tier 4 with hint "use a much longer word"')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '✕ Stop run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('failed')
  await expect(page.getByTestId('timeline-events')).toContainText('pick: stopped by studio')
})
