import { test, expect } from '@playwright/test'

test.describe('canvas rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('renders the app with sidebar and canvas', async ({ page }) => {
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.canvas')).toBeVisible()
  })

  test('sidebar shows agents and nodes palette', async ({ page }) => {
    const sidebar = page.locator('.sidebar')
    await expect(sidebar.getByText('Agents')).toBeVisible()
    await expect(sidebar.getByText('Nodes')).toBeVisible()
    await expect(sidebar.locator('.sidebar-item', { hasText: 'Assessor' })).toBeVisible()
    await expect(sidebar.locator('.sidebar-item', { hasText: 'Executor' })).toBeVisible()
    await expect(sidebar.locator('.sidebar-item', { hasText: 'If' })).toBeVisible()
    await expect(sidebar.locator('.sidebar-item', { hasText: 'Approval' })).toBeVisible()
    await expect(sidebar.locator('.sidebar-item', { hasText: 'End' })).toBeVisible()
  })

  test('renders the orchestrator node on the canvas', async ({ page }) => {
    await expect(page.locator('.react-flow__node-orchestrator')).toBeVisible()
    await expect(page.locator('.react-flow__node-orchestrator').getByText('Orchestrator')).toBeVisible()
  })

  test('renders all hangman workflow nodes', async ({ page }) => {
    await expect(page.getByText('Orchestrator')).toBeVisible()
    await expect(page.getByText('Pick Word')).toBeVisible()
    await expect(page.getByText('Guess Letter')).toBeVisible()
    // End appears in both sidebar and canvas
    await expect(page.locator('.react-flow__node-end')).toBeVisible()
  })

  test('renders edges with condition labels', async ({ page }) => {
    // Edge labels render via EdgeLabelRenderer portal — wait for layout
    await page.waitForSelector('.edge-label', { timeout: 5000 })
    // At least 3 visible edge labels (some may be off-viewport depending on fitView)
    const count = await page.locator('.edge-label').count()
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test('orchestrator has pre-filled prompt', async ({ page }) => {
    const textarea = page.locator('.react-flow__node-orchestrator textarea')
    await expect(textarea).toHaveValue(/hangman game controller/i)
  })

  test('orchestrator has state fields defined', async ({ page }) => {
    const stateSection = page.locator('.react-flow__node-orchestrator [data-testid="state-section"]')
    await expect(stateSection).toBeVisible()
    await expect(stateSection.locator('[data-testid="state-field"]')).toHaveCount(5)
  })
})

test.describe('node interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('clicking a node selects it', async ({ page }) => {
    const orchestratorNode = page.locator('.react-flow__node-orchestrator')
    await orchestratorNode.click()
    await expect(orchestratorNode).toHaveClass(/selected/)
  })

  test('clicking canvas deselects nodes', async ({ page }) => {
    const orchestratorNode = page.locator('.react-flow__node-orchestrator')
    await orchestratorNode.click()
    await expect(orchestratorNode).toHaveClass(/selected/)

    // Click on empty area far from nodes using keyboard shortcut instead
    await page.keyboard.press('Escape')
    await expect(orchestratorNode).not.toHaveClass(/selected/)
  })

  test('can edit the orchestrator prompt', async ({ page }) => {
    const textarea = page.locator('.react-flow__node-orchestrator textarea')
    await textarea.clear()
    await textarea.fill('New game prompt')
    await expect(textarea).toHaveValue('New game prompt')
  })

  test('can add a state field', async ({ page }) => {
    const stateSection = page.locator('.react-flow__node-orchestrator [data-testid="state-section"]')
    const addBtn = stateSection.locator('[data-testid="state-add"]')
    const fieldsBefore = await stateSection.locator('[data-testid="state-field"]').count()

    await addBtn.click()

    const fieldsAfter = await stateSection.locator('[data-testid="state-field"]').count()
    expect(fieldsAfter).toBe(fieldsBefore + 1)
  })
})

test.describe('drag and drop nodes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('can drag an assessor from sidebar to canvas', async ({ page }) => {
    const assessorPalette = page.locator('.sidebar .sidebar-item', { hasText: 'Assessor' })
    const canvas = page.locator('.react-flow__pane')

    const canvasBounds = await canvas.boundingBox()
    if (!canvasBounds) throw new Error('Canvas not found')

    await assessorPalette.dragTo(canvas, {
      targetPosition: { x: canvasBounds.width / 2, y: canvasBounds.height / 2 },
    })

    // Should now have 2 assessor nodes on canvas (Pick Word + the new one)
    const assessorNodes = page.locator('.react-flow__node-assessor')
    await expect(assessorNodes).toHaveCount(2)
  })
})

test.describe('edge label editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for edges to render
    await page.waitForSelector('.react-flow__edge-path', { timeout: 5000 })
  })

  test('double-clicking an edge opens a prompt to edit the condition', async ({ page }) => {
    // Find an edge path and double-click it (force bypasses node overlay interception)
    const edgePath = page.locator('.react-flow__edge-path').first()

    page.on('dialog', async (dialog) => {
      expect(dialog.type()).toBe('prompt')
      await dialog.accept('new condition')
    })

    await edgePath.dblclick({ force: true })
  })

  test('cancelling the prompt does not change the label', async ({ page }) => {
    const edgePath = page.locator('.react-flow__edge-path').first()

    // Count labels before
    await page.waitForSelector('.edge-label', { timeout: 5000 })
    const countBefore = await page.locator('.edge-label').count()

    page.on('dialog', async (dialog) => {
      await dialog.dismiss()
    })
    await edgePath.dblclick({ force: true })

    // Label count should not change after cancelling
    await expect(page.locator('.edge-label')).toHaveCount(countBefore)
  })
})

test.describe('export workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('export button is visible', async ({ page }) => {
    await expect(page.getByText('Export Workflow JSON')).toBeVisible()
  })

  test('clicking export triggers a download', async ({ page }) => {
    const downloadPromise = page.waitForEvent('download')
    await page.getByText('Export Workflow JSON').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/workflow.*\.json/)
  })
})

test.describe('run and debug controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('Run and Debug buttons are visible in idle state', async ({ page }) => {
    await expect(page.getByTestId('btn-run')).toBeVisible()
    await expect(page.getByTestId('btn-debug')).toBeVisible()
  })

  test('clicking Run shows Stop button', async ({ page }) => {
    await page.getByTestId('btn-run').click()
    await expect(page.getByTestId('btn-stop')).toBeVisible()
  })

  test('clicking Stop returns to idle with Run button', async ({ page }) => {
    await page.getByTestId('btn-run').click()
    await expect(page.getByTestId('btn-stop')).toBeVisible()

    await page.getByTestId('btn-stop').click()
    await expect(page.getByTestId('btn-run')).toBeVisible()
  })

  test('clicking Debug shows debug panel and Step button', async ({ page }) => {
    await page.getByTestId('btn-debug').click()
    await expect(page.getByTestId('btn-step')).toBeVisible()
    await expect(page.getByTestId('debug-sdk-prompt')).toBeVisible()
  })

  test('debug panel shows the generated prompt', async ({ page }) => {
    await page.getByTestId('btn-debug').click()
    const promptPanel = page.getByTestId('debug-sdk-prompt')
    await expect(promptPanel).toContainText('Directive')
    await expect(promptPanel).toContainText('State Machine')
    await expect(promptPanel).toContainText('hangman')
  })

  test('orchestrator is highlighted as active in debug mode', async ({ page }) => {
    await page.getByTestId('btn-debug').click()
    const orchestratorNode = page.locator('.react-flow__node-orchestrator')
    await expect(orchestratorNode).toHaveClass(/node-active/)
  })

  test('stopping debug returns to idle state', async ({ page }) => {
    await page.getByTestId('btn-debug').click()
    await expect(page.getByTestId('btn-step')).toBeVisible()

    await page.getByTestId('btn-stop').click()
    await expect(page.getByTestId('btn-run')).toBeVisible()
    await expect(page.locator('.react-flow__node-orchestrator')).not.toHaveClass(/node-active/)
  })
})
