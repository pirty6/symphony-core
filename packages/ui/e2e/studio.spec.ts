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
  // First the tool step that recalls earlier runs, then the first AI step.
  await expect(gate).toContainText('Paused before “recall”')
  await gate.getByRole('button', { name: '⏭ Step' }).click()
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
  await page.getByTestId('toggle-demo-runs').click()
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
  await page.getByTestId('toggle-demo-runs').click()
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
    if (route.request().method() !== 'POST') return route.continue()
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

test('then run: a successful run hands its result to the next pattern, and the studio follows it', async ({ page }) => {
  await open(page, 'investigate')
  await page.getByLabel('auto-approve').check()
  await page.getByLabel('then run').selectOption('fix')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('notice')).toContainText("investigate finished. Now playing 'fix' with what it found.")
  await expect(page.locator('.tb-title')).toContainText('fix')
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await expect(page.getByTestId('run-result')).toContainText("reached end 'fixed'")
  await page.getByRole('button', { name: 'State' }).click()
  await expect(page.getByTestId('state-issue')).toContainText('What the investigate run found')
})

test('several runs play at once on one server; the studio switches between them', async ({ page }) => {
  await open(page, 'hangman')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('approval-card')).toBeVisible()
  // A second run while the first waits for its guess.
  await page.locator('button.lib-item').filter({ has: page.locator('b', { hasText: /^fix$/ }) }).click()
  await expect(page.locator('.tb-title')).toContainText('fix')
  await page.getByText('auto-approve').click()
  await page.getByLabel('step mode').check()
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('gate-card')).toContainText('Paused before “recall”')
  const live = page.getByTestId('live-runs')
  await expect(live.getByRole('button', { name: /fix/ }).first()).toContainText('on screen')
  // Newest first: the first hangman is the one started above, still waiting for a guess.
  await live.getByRole('button', { name: /hangman/ }).first().click()
  await expect(page.locator('.tb-title')).toContainText('hangman')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await guess(page, 'p')
  // And back to fix, still paused where it was.
  await live.getByRole('button', { name: /fix/ }).first().click()
  await expect(page.locator('.tb-title')).toContainText('fix')
  await expect(page.getByTestId('gate-card')).toContainText('Paused before “recall”')
})

test('inputs start empty with the demo as a hint, the large editor writes into them, and offline runs still work', async ({ page }) => {
  await open(page, 'fix')
  const issue = page.getByLabel('context issue', { exact: true })
  await expect(issue).toHaveValue('')
  await expect(issue).toHaveAttribute('placeholder', /^e\.g\. Page 2 repeats the last item of page 1/)
  await page.locator('.prompt-box').filter({ has: issue }).getByLabel('large editor').click()
  // The editor's text area sits inside the dialog's card, filling most of it.
  const card = (await page.locator('.prompt-editor').boundingBox())!
  const text = (await page.getByLabel('large editor text').boundingBox())!
  expect(text.x).toBeGreaterThanOrEqual(card.x)
  expect(text.y).toBeGreaterThanOrEqual(card.y)
  expect(text.x + text.width).toBeLessThanOrEqual(card.x + card.width)
  expect(text.y + text.height).toBeLessThanOrEqual(card.y + card.height)
  expect(text.height).toBeGreaterThan(card.height / 2)
  await page.getByLabel('large editor text').fill('Totals are wrong\nwhen a coupon applies')
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click()
  await expect(issue).toHaveValue('Totals are wrong\nwhen a coupon applies')
  // Blank again: the offline demo plays its own example.
  await issue.fill('')
  await page.getByText('auto-approve').click()
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done')
})

test('a lost server says so and reconnects; request errors close with ✕ and clear when switching runs', async ({ page }) => {
  await open(page, 'hangman')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('approval-card')).toBeVisible()
  // The server goes away: the poll shows it, and it clears itself when the server answers again.
  await page.route('**/api/runs', (r) => r.abort())
  await expect(page.getByTestId('server-down')).toBeVisible()
  const alert = page.getByRole('alert')
  await page.locator('button.lib-item:not(.saved)').filter({ has: page.locator('b', { hasText: /^fix$/ }) }).click()
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(alert).toContainText('Could not reach the studio server')
  await expect(alert).not.toContainText('Failed to fetch')
  await alert.getByRole('button', { name: 'dismiss' }).click()
  await expect(alert).toBeHidden()
  await page.unroute('**/api/runs')
  await expect(page.getByTestId('server-down')).toBeHidden()
  // An error, then another run is opened: the error was about the last action, so it goes.
  await page.route('**/api/runs', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()))
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(alert).toBeVisible()
  await page.getByTestId('live-runs').getByRole('button', { name: /hangman/ }).first().click()
  await expect(page.locator('.tb-title')).toContainText('hangman')
  await expect(alert).toBeHidden()
})

test('an answer that does not get through can be sent again', async ({ page }) => {
  await open(page, 'hangman')
  await page.getByRole('button', { name: '▶ Run' }).click()
  const card = page.getByTestId('approval-card')
  await card.getByLabel('letter', { exact: true }).fill('e')
  await page.route('**/api/runs/*/approval', (r) => r.abort())
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Could not reach the studio server')
  // Not stuck disabled: the same answer goes through once the server answers again.
  await page.unroute('**/api/runs/*/approval')
  await expect(card.getByLabel('letter', { exact: true })).toBeEnabled()
  await guess(page, 'e')
})

for (const lose of ['restarted', 'unreachable'] as const) {
  test(`stop always ends a paused run: server ${lose}`, async ({ page }) => {
    await open(page, 'fix')
    await page.getByText('auto-approve').click()
    await page.getByLabel('step mode').check()
    await page.getByRole('button', { name: '▶ Run' }).click()
    const gate = page.getByTestId('gate-card')
    await expect(gate).toBeVisible()
    await page.route('**/api/runs/*/control', (r) =>
      lose === 'restarted' ? r.fulfill({ status: 404, json: { error: 'run not found' } }) : r.abort(),
    )
    await gate.getByRole('button', { name: '⏹ Stop' }).click()
    await expect(gate).toBeHidden()
    await expect(page.getByTestId('run-status')).toHaveText('cancelled')
    await expect(page.getByTestId('run-result')).toContainText(
      lose === 'restarted' ? 'no longer on the server' : 'could not be reached to stop it',
    )
  })
}
