import { expect, test, type Page } from '@playwright/test'
import { investigate } from '../../../src/patterns/investigate'

async function open(page: Page, pattern: string) {
  await page.goto(`/#${pattern}`)
  await expect(page.locator('.tb-title')).toContainText(pattern)
  await expect(page.getByText(/Valid: every path is bounded/)).toBeVisible()
}

/** "Running now" starts closed: open it (it then stays open, remembered). */
async function runningNow(page: Page) {
  const live = page.getByTestId('live-runs')
  const toggle = live.getByRole('button', { name: /Running now/ })
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  return live
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
  await page.getByRole('button', { name: 'State', exact: true }).click()
  await expect(page.getByTestId('state-won')).toContainText('true')
})

test('step mode halts before and after the AI; the proposed result is visible before it is applied', async ({ page }) => {
  await open(page, 'fix')
  await page.getByText('auto-approve').click()
  await page.getByLabel('step mode').check()
  await page.getByRole('button', { name: '▶ Run' }).click()
  const gate = page.getByTestId('gate-card')
  // First the tool steps (the tests before any edit, snapshot, recall), then the first AI step.
  await expect(gate).toContainText('Paused before “baseline”')
  await gate.getByRole('button', { name: '⏭ Step' }).click()
  await expect(gate).toContainText('Paused before “snapshot”')
  await gate.getByRole('button', { name: '⏭ Step' }).click()
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
  // A saved run, not a live one ("Running now" items look the same).
  await page.getByTestId('saved-run').first().locator('.lib-item').click()
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
  // The tested fix pattern, tailored: the gate shows what was changed for this request.
  await expect(page.getByTestId('composed-headline')).toContainText('fix: the tested library pattern')
  // Its steps are folded away: it is not a new algorithm.
  await expect(page.getByTestId('composed-steps')).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('tailoring')).toContainText('hypothesize: It fails about once in ten CI runs')
  await expect(page.getByTestId('tailoring')).toContainText('maxAttempts = 2')
  // How each requirement is met, before the go.
  await expect(page.getByTestId('approval-card')).toContainText(/R1: \w+ — /)
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
  // A saved run, not a live one ("Running now" items look the same).
  await page.getByTestId('saved-run').first().locator('.lib-item').click()
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
  // Stopped at a step that cannot answer: partial, with the work so far kept.
  await expect(page.getByTestId('run-status')).toHaveText('done')
  await expect(page.getByTestId('run-result')).toContainText('partial')
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
  await page.getByRole('button', { name: 'State', exact: true }).click()
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
  await expect(page.getByTestId('gate-card')).toContainText('Paused before “baseline”')
  const live = await runningNow(page)
  await expect(live.getByRole('button', { name: /fix/ }).first()).toContainText('on screen')
  // Newest first: the first hangman is the one started above, still waiting for a guess.
  await live.getByRole('button', { name: /hangman/ }).first().click()
  await expect(page.locator('.tb-title')).toContainText('hangman')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await guess(page, 'p')
  // And back to fix, still paused where it was.
  await live.getByRole('button', { name: /fix/ }).first().click()
  await expect(page.locator('.tb-title')).toContainText('fix')
  await expect(page.getByTestId('gate-card')).toContainText('Paused before “baseline”')
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
  await (await runningNow(page)).getByRole('button', { name: /hangman/ }).first().click()
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

test('deletes one saved run from the list after a second click', async ({ page }) => {
  await open(page, 'review')
  await page.getByText('auto-approve').click()
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done')
  const toggle = page.getByTestId('toggle-demo-runs')
  if ((await toggle.innerText()).startsWith('Show')) await toggle.click()
  const newest = page.getByTestId('saved-run').filter({ has: page.locator('b', { hasText: /^review$/ }) }).first()
  await expect(newest).toBeVisible()
  // Other tests' runs may still be saving: follow this run by its file, not by position or count.
  const file = (await newest.getAttribute('data-file'))!
  // Windows paths have backslashes, which CSS selectors read as escapes.
  const mine = page.locator(`[data-testid="saved-run"][data-file="${file.replaceAll('\\', '\\\\')}"]`)
  const trash = mine.getByRole('button', { name: 'delete run' })
  // The trash can shows only while hovering the run.
  await page.locator('.tb-title').hover()
  await expect(trash).toHaveCSS('opacity', '0')
  // The list refreshes when the run ends and rows can move under the mouse: hover again until it shows.
  await expect(async () => {
    await mine.hover()
    await expect(trash).toHaveCSS('opacity', '1', { timeout: 500 })
  }).toPass()
  await trash.click()
  // One click only asks; Keep leaves it.
  await mine.getByRole('button', { name: 'keep' }).click()
  await expect(mine).toHaveCount(1)
  await mine.hover()
  await trash.click()
  await mine.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(mine).toHaveCount(0)
})

test('the extras toggle shows optional patterns, and is remembered', async ({ page }) => {
  await open(page, 'hangman')
  const metaphorItem = page.locator('button.lib-item:not(.saved)').filter({ has: page.locator('b', { hasText: /^metaphor$/ }) })
  const toggle = page.getByLabel('extra patterns')
  await expect(toggle).not.toBeChecked()
  await expect(metaphorItem).toHaveCount(0)
  await toggle.check()
  await expect(metaphorItem).toHaveCount(1)
  await expect(metaphorItem).toContainText('extra')
  await page.reload()
  await expect(page.getByLabel('extra patterns')).toBeChecked()
  await expect(metaphorItem).toHaveCount(1)
  await page.getByLabel('extra patterns').uncheck()
  await expect(metaphorItem).toHaveCount(0)
})

test('the minimap lights up where the run is, as the diagram does', async ({ page }) => {
  await open(page, 'hangman')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('node-ask')).toHaveAttribute('data-status', 'paused')
  const minimap = page.locator('.react-flow__minimap')
  await expect(minimap.locator('.react-flow__minimap-node.minimap-paused')).toHaveCount(1)
  await expect(minimap.locator('.react-flow__minimap-node.minimap-paused')).toHaveCSS('fill', 'rgb(52, 211, 153)')
  await expect(minimap.locator('.react-flow__minimap-node.minimap-done').first()).toBeAttached()
})

test('during a run, nodes and closed phases can be moved, but nothing can be connected', async ({ page }) => {
  await open(page, 'investigate')
  await page.getByLabel('step mode').check()
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('gate-card')).toBeVisible()
  // Bring every node into view first (the window may be small).
  await page.locator('.react-flow__controls-fitview').click()
  const phase = page.locator('.react-flow__node[data-id="planPhase"]')
  const before = await phase.evaluate((el) => (el as HTMLElement).style.transform)
  const box = (await phase.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + 40, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => phase.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(before)
  // Connections stay as the pattern says: no handle accepts a new edge while it plays.
  await expect(page.locator('.react-flow__handle.connectable')).toHaveCount(0)
  await page.getByTestId('gate-card').getByRole('button', { name: '⏹ Stop' }).click()
})

test('the sub-agents of a fanned-out step show as nodes beside it, each with its state', async ({ page }) => {
  await open(page, 'investigate')
  // Small batches and two sub-agents, so triage splits into parts.
  await page.getByText(/^Other initial state/).click()
  await page.getByLabel('context batchSize', { exact: true }).fill('1')
  await page.getByLabel('context agents', { exact: true }).fill('2')
  await page.getByText('auto-approve').click()
  await page.getByLabel('step mode').check()
  await page.getByRole('button', { name: '▶ Run' }).click()
  const gate = page.getByTestId('gate-card')
  for (let i = 0; i < 40 && !(await page.getByTestId('subagent-1').isVisible()); i++) {
    await gate.getByRole('button', { name: '⏭ Step' }).click()
    await page.waitForTimeout(100)
  }
  await expect(page.getByTestId('subagent-1')).toBeVisible()
  await expect(page.getByTestId('subagent-2')).toBeVisible()
  await expect(page.getByTestId('subagent-1')).toHaveAttribute('data-state', /done|running/)
  // Two sub-agents, three parts each per wave: all five demo files in one wave.
  await expect(page.getByTestId('subagent-1')).toContainText(/Sub-agent 1\/5/)
  // A sub-agent shows its step's AI output.
  await page.getByTestId('subagent-1').click()
  await expect(page.getByRole('button', { name: 'AI output', exact: true })).toHaveClass(/\bon\b/)
  await page.screenshot({ path: 'test-results/subagents.png' })
  await gate.getByRole('button', { name: '⏹ Stop' }).click()
})

test('library sections fold away, and a feature switch reaches the run it starts', async ({ page }) => {
  await open(page, 'investigate')
  await page.evaluate(() => localStorage.removeItem('symphony.open.patterns'))
  // Sections fold from their titles.
  const patterns = page.getByRole('button', { name: 'Patterns', exact: true })
  await expect(patterns).toHaveAttribute('aria-expanded', 'true')
  await patterns.click()
  await expect(page.getByText('+ Blank pattern')).toHaveCount(0)
  await patterns.click()
  await expect(page.getByText('+ Blank pattern')).toBeVisible()
  // The switches this pattern has; the judge in shadow mode for the next run.
  const judge = page.getByTestId('feature-supportJudge')
  await expect(judge).toBeVisible()
  await judge.getByLabel('Support judge').selectOption('shadow')
  await expect(judge).toContainText('changed')
  await page.getByText('auto-approve').click()
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.getByTestId('run-status')).toHaveText('done', { timeout: 30_000 })
  // A long answer opens the reader by itself.
  await expect(page.getByTestId('result-reader')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'State', exact: true }).click()
  await expect(page.getByTestId('state-supportJudge')).toContainText('shadow')
  // The judge played (the demo's rulings): every cited workspace finding was ruled on.
  await expect(page.getByTestId('state-supportRulings')).toContainText('SUPPORTED')
  // Kept for the next visit, and the section says how many switches are changed.
  await page.reload()
  await expect(page.getByTestId('feature-supportJudge').getByLabel('Support judge')).toHaveValue('shadow')
  await expect(page.getByTestId('features-changed')).toHaveText('1 changed')
  // Set back to its default, it is no longer marked.
  await page.getByTestId('feature-supportJudge').getByLabel('Support judge').selectOption('off')
  await expect(page.getByTestId('feature-supportJudge')).not.toContainText('changed')
  await expect(page.getByTestId('features-changed')).toHaveCount(0)
  // Reset puts every switch back at once.
  await page.getByTestId('feature-supportJudge').getByLabel('Support judge').selectOption('shadow')
  await page.getByTestId('feature-singlePass').getByRole('checkbox').check()
  await expect(page.getByTestId('features-changed')).toHaveText('2 changed')
  await page.getByTestId('section-features').getByRole('button', { name: 'Reset' }).click()
  await expect(page.getByTestId('features-changed')).toHaveCount(0)
  await expect(page.getByTestId('feature-supportJudge').getByLabel('Support judge')).toHaveValue('off')
})

test('the opening screen asks the maestro; inside a pattern or a run the sidebar does', async ({ page }) => {
  await page.goto('/')
  const home = page.getByTestId('home')
  await expect(home.getByRole('heading', { name: 'What should the orchestra play?' })).toBeVisible()
  // One maestro prompt on screen: the sidebar does not repeat it here.
  await expect(page.locator('.library').getByText('🎼 Ask the maestro')).toHaveCount(0)
  await expect(page.locator('.tb-title')).toContainText('Symphony')
  await expect(page.getByRole('button', { name: '▶ Run' })).toHaveCount(0)
  // Open a pattern from the screen: the canvas, and the maestro box in the sidebar.
  await home.getByRole('button', { name: 'fix', exact: true }).click()
  await expect(page.locator('.tb-title')).toContainText('fix')
  await expect(home).toHaveCount(0)
  await expect(page.locator('.library').getByText('🎼 Ask the maestro')).toBeVisible()
  // And back.
  await page.getByTestId('home-link').click()
  await expect(page.getByTestId('home')).toBeVisible()
  // Asking from the opening screen starts the maestro and follows it.
  await page.getByText('auto-approve').click()
  await page.getByTestId('home').getByLabel('maestro request').fill('Fix the flaky login test')
  await page.getByTestId('home').getByRole('button', { name: '🎼 Compose & perform' }).click()
  await expect(page.getByTestId('home')).toHaveCount(0)
  await expect(page.locator('.tb-title')).toContainText(/maestro|fix/)
})

test('every feature switch fits inside its card, even with larger text', async ({ page }) => {
  await open(page, 'investigate')
  // Larger text than the default (browser zoom, OS font settings): where a select crowded out.
  await page.addStyleTag({ content: '.library { font-size: 16px } .library select { font-size: 15px }' })
  const cards = page.locator('[data-testid^="feature-"]')
  await expect(cards.first()).toBeVisible()
  for (let i = 0; i < (await cards.count()); i++) {
    const card = (await cards.nth(i).boundingBox())!
    const control = (await cards.nth(i).locator('select, input').first().boundingBox())!
    expect(control.x).toBeGreaterThanOrEqual(card.x)
    expect(control.x + control.width).toBeLessThanOrEqual(card.x + card.width + 0.5)
    // The title is not squeezed under the control: its text fits its box, and the boxes do not meet.
    const title = cards.nth(i).locator('label > span').first()
    const spills = await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(spills, await title.innerText()).toBe(false)
    const t = (await title.boundingBox())!
    const apart =
      t.x + t.width <= control.x + 0.5 || control.x + control.width <= t.x + 0.5 || t.y + t.height <= control.y + 0.5 || control.y + control.height <= t.y + 0.5
    expect(apart, await title.innerText()).toBe(true)
  }
})

test('the top bar never pushes the run controls off screen, down to the narrowest studio', async ({ page }) => {
  for (const width of [1100, 1280]) {
    await page.setViewportSize({ width, height: 760 })
    await open(page, 'investigate')
    // GitHub Copilot adds the model field: the widest the settings get.
    await page.getByLabel('provider').selectOption('copilot')
    const bar = (await page.locator('.toolbar').boundingBox())!
    const run = (await page.getByRole('button', { name: '▶ Run' }).boundingBox())!
    expect(run.x + run.width, `Run at ${width}px`).toBeLessThanOrEqual(bar.x + bar.width)
    expect(await page.locator('.toolbar').evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
    // Every setting is still on screen, not scrolled away.
    for (const label of ['provider', 'model', 'complexity', 'improvisation', 'step mode']) {
      const box = (await page.locator('.toolbar').getByLabel(label, { exact: true }).boundingBox())!
      expect(box.x + box.width, `${label} at ${width}px`).toBeLessThanOrEqual(run.x)
    }
    await page.getByLabel('provider').selectOption('scripted')
  }
})
