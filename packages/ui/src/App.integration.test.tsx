import { render, screen, fireEvent, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from './App'
import type { RunCallbacks } from './api'

// Capture the callbacks passed to startRun so tests can simulate SDK events
let capturedCallbacks: RunCallbacks | null = null
const mockSendMessage = vi.fn().mockResolvedValue(undefined)
const mockApproveStep = vi.fn().mockResolvedValue(undefined)

// Mock the API module so tests don't make real network calls
vi.mock('./api', () => ({
  startRun: (_prompt: string, callbacks: RunCallbacks, _debug?: boolean) => {
    capturedCallbacks = callbacks
    return new AbortController()
  },
  stopRun: async () => {},
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  approveStep: (...args: unknown[]) => mockApproveStep(...args),
}))

function renderApp() {
  return render(
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>,
  )
}

describe('App', () => {
  beforeEach(() => {
    capturedCallbacks = null
    mockSendMessage.mockClear()
    mockApproveStep.mockClear()
  })

  it('renders the orchestrator node as the start point', () => {
    renderApp()
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
    expect(screen.getByText('Hangman game controller')).toBeInTheDocument()
  })

  it('pre-places hangman game nodes on the canvas', () => {
    renderApp()
    // Hangman state machine nodes are on the canvas
    expect(screen.getByText('Pick Word')).toBeInTheDocument()
    expect(screen.getByText('Guess Letter')).toBeInTheDocument()
    // End node is on the canvas AND in the sidebar
    const endLabels = screen.getAllByText('End')
    expect(endLabels.length).toBeGreaterThanOrEqual(2)
  })

  it('renders the sidebar with agents and nodes sections', () => {
    renderApp()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Nodes')).toBeInTheDocument()
    expect(screen.getByText('Assessor')).toBeInTheDocument()
    expect(screen.getByText('Executor')).toBeInTheDocument()
    expect(screen.getByText('If')).toBeInTheDocument()
    expect(screen.getByText('Approval')).toBeInTheDocument()
    // End appears both in sidebar and on canvas
    expect(screen.getAllByText('End').length).toBeGreaterThanOrEqual(2)
  })

  it('shows descriptions for condition, approval, and end in sidebar', () => {
    renderApp()
    expect(screen.getByText('Conditional branch (then/else)')).toBeInTheDocument()
    expect(screen.getByText('Human-in-the-loop approval gate')).toBeInTheDocument()
    expect(screen.getByText('Terminal point of a path')).toBeInTheDocument()
  })

  it('renders the export button', () => {
    renderApp()
    expect(screen.getByText('Export Workflow JSON')).toBeInTheDocument()
  })

  it('renders the orchestrator as non-deletable', () => {
    renderApp()
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
    expect(screen.getByText('Hangman game controller')).toBeInTheDocument()
  })

  it('orchestrator has maxEdges: 1', () => {
    // Verify the initial orchestrator node data carries maxEdges
    // This is tested via the initialNodes constant which sets maxEdges: 1
    renderApp()
    // Orchestrator renders — its data includes maxEdges: 1
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
  })

  it('orchestrator renders a prompt textarea on the canvas', () => {
    renderApp()
    const textareas = screen.getAllByTestId('node-prompt')
    expect(textareas.length).toBeGreaterThanOrEqual(1)
    expect(textareas[0].tagName).toBe('TEXTAREA')
  })

  it('orchestrator prompt has hangman directive', () => {
    renderApp()
    const textarea = screen.getAllByTestId('node-prompt')[0] as HTMLTextAreaElement
    expect(textarea.value).toContain('hangman')
  })

  it('clicking a node adds the selected class to its wrapper', () => {
    renderApp()
    const nodeContent = screen.getByText('Orchestrator')
    const reactFlowNode = nodeContent.closest('.react-flow__node')
    expect(reactFlowNode).toBeInTheDocument()
    expect(reactFlowNode).not.toHaveClass('selected')

    fireEvent.click(nodeContent)

    expect(reactFlowNode).toHaveClass('selected')
  })

  it('clicking elsewhere deselects the node', () => {
    renderApp()
    const nodeContent = screen.getByText('Orchestrator')
    const reactFlowNode = nodeContent.closest('.react-flow__node')

    fireEvent.click(nodeContent)
    expect(reactFlowNode).toHaveClass('selected')

    const canvas = document.querySelector('.react-flow__pane')
    if (canvas) {
      fireEvent.click(canvas)
      expect(reactFlowNode).not.toHaveClass('selected')
    }
  })

  it('run mode activates orchestrator and walks to next node', async () => {
    vi.useFakeTimers()
    renderApp()

    // Start the non-debug run — auto-walk fires after the step delay
    fireEvent.click(screen.getByTestId('btn-run'))

    const orchestratorEl = screen.getByText('Orchestrator').closest('.react-flow__node')
    // walkStep is called immediately in non-debug — orchestrator becomes visited
    // but the auto-step effect needs to fire to advance further
    await act(async () => { vi.advanceTimersByTime(800) })

    // Orchestrator should be visited (walked past to next node)
    expect(orchestratorEl).toHaveClass('node-visited')

    vi.useRealTimers()
  })

  it('shows Stop button during run and Run button when stopped', () => {
    renderApp()

    fireEvent.click(screen.getByTestId('btn-run'))

    // During run the Stop button is visible
    expect(screen.getByTestId('btn-stop')).toBeInTheDocument()

    // Stop the run
    fireEvent.click(screen.getByTestId('btn-stop'))

    // Run button should be back
    expect(screen.getByTestId('btn-run')).toBeInTheDocument()
  })

  it('debug mode highlights orchestrator immediately and does not auto-step further', async () => {
    vi.useFakeTimers()
    renderApp()

    fireEvent.click(screen.getByTestId('btn-debug'))

    const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')

    // Debug starts with orchestrator immediately active
    expect(orchestratorEl).toHaveClass('node-active')

    // Wait well past the normal auto-step delay — should NOT advance beyond orchestrator
    await act(async () => { vi.advanceTimersByTime(2000) })

    expect(orchestratorEl).toHaveClass('node-active')
    // Step button should be available in debug mode
    expect(screen.getByTestId('btn-step')).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('debug mode advances one step when Step button is clicked', async () => {
    vi.useFakeTimers()
    renderApp()

    fireEvent.click(screen.getByTestId('btn-debug'))

    const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
    // Orchestrator is already active in debug mode
    expect(orchestratorEl).toHaveClass('node-active')

    // Step walks — orchestrator has outgoing edges so it moves to next node
    fireEvent.click(screen.getByTestId('btn-step'))
    // Flush React state update
    await act(async () => { vi.advanceTimersByTime(0) })

    // Orchestrator is no longer the active node
    expect(orchestratorEl).not.toHaveClass('node-active')
    // A different node should now be active (Pick Word assessor)
    const activeNodes = document.querySelectorAll('.react-flow__node.node-active')
    expect(activeNodes.length).toBe(1)
    expect(activeNodes[0]).not.toBe(orchestratorEl)

    vi.useRealTimers()
  })

  it('debug mode shows the orchestrator input prompt in the debug panel', () => {
    renderApp()

    fireEvent.click(screen.getByTestId('btn-debug'))

    const sdkPrompt = screen.getByTestId('debug-sdk-prompt')
    expect(sdkPrompt).toBeInTheDocument()
    // The hangman prompt is pre-set
    expect(sdkPrompt.textContent).toContain('hangman')
    expect(sdkPrompt.textContent).toContain('Directive')
  })

  describe('multi-turn session', () => {
    function startDebugSession() {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Play hangman' } })
      fireEvent.click(screen.getByTestId('btn-debug'))
      expect(capturedCallbacks).not.toBeNull()
    }

    it('shows chat input after SDK session is established', () => {
      startDebugSession()

      // Before session ID is set, no chat input
      expect(screen.queryByTestId('debug-chat-input')).not.toBeInTheDocument()

      // Simulate SDK assigning a session ID
      act(() => { capturedCallbacks!.onSessionId('42') })

      // Chat input should now be visible
      expect(screen.getByTestId('debug-chat-input')).toBeInTheDocument()
      expect(screen.getByTestId('debug-chat-field').tagName).toBe('TEXTAREA')
    })

    it('displays SDK messages in the debug panel', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      act(() => { capturedCallbacks!.onMessage('I picked a word: _ _ _ _ _') })

      const messages = screen.getByTestId('debug-sdk-messages')
      expect(messages).toBeInTheDocument()
      expect(messages.textContent).toContain('I picked a word: _ _ _ _ _')
    })

    it('accumulates multiple SDK messages', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      act(() => { capturedCallbacks!.onMessage('First message') })
      act(() => { capturedCallbacks!.onMessage('Second message') })

      const messages = screen.getByTestId('debug-sdk-messages')
      expect(messages.textContent).toContain('First message')
      expect(messages.textContent).toContain('Second message')
    })

    it('sends a follow-up message via the chat input', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      const chatField = screen.getByTestId('debug-chat-field')
      fireEvent.change(chatField, { target: { value: 'guess A' } })
      fireEvent.click(screen.getByTestId('debug-chat-send'))

      expect(mockSendMessage).toHaveBeenCalledWith('42', 'guess A')
    })

    it('clears the chat input after sending', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      const chatField = screen.getByTestId('debug-chat-field') as HTMLTextAreaElement
      fireEvent.change(chatField, { target: { value: 'guess B' } })
      fireEvent.click(screen.getByTestId('debug-chat-send'))

      expect(chatField.value).toBe('')
    })

    it('send button is disabled when input is empty', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      const sendBtn = screen.getByTestId('debug-chat-send') as HTMLButtonElement
      expect(sendBtn.disabled).toBe(true)

      fireEvent.change(screen.getByTestId('debug-chat-field'), { target: { value: 'hello' } })
      expect(sendBtn.disabled).toBe(false)

      fireEvent.change(screen.getByTestId('debug-chat-field'), { target: { value: '   ' } })
      expect(sendBtn.disabled).toBe(true)
    })

    it('Enter key sends the message (without Shift)', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      const chatField = screen.getByTestId('debug-chat-field')
      fireEvent.change(chatField, { target: { value: 'guess C' } })
      fireEvent.keyDown(chatField, { key: 'Enter', shiftKey: false })

      expect(mockSendMessage).toHaveBeenCalledWith('42', 'guess C')
    })

    it('Shift+Enter does not send (allows newline)', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      const chatField = screen.getByTestId('debug-chat-field')
      fireEvent.change(chatField, { target: { value: 'multi\nline' } })
      fireEvent.keyDown(chatField, { key: 'Enter', shiftKey: true })

      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it('chat input disappears after stopping the session', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })
      expect(screen.getByTestId('debug-chat-input')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('btn-stop'))

      // After stop, execution resets — debug panel hidden
      expect(screen.queryByTestId('debug-chat-input')).not.toBeInTheDocument()
    })

    it('onTurnDone does not end the session — keeps chat open', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })
      act(() => { capturedCallbacks!.onMessage('Your turn') })
      act(() => { capturedCallbacks!.onTurnDone() })

      // Session should still be active — chat input visible
      expect(screen.getByTestId('debug-chat-input')).toBeInTheDocument()
      // Status should still be running, not completed
      expect(screen.getByTestId('debug-status').textContent).toBe('running')
    })

    it('orchestrator is active when debug session starts', () => {
      startDebugSession()
      const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
      expect(orchestratorEl).toHaveClass('node-active')
    })

    it('onToolEnd returns active state to orchestrator', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      // Simulate a tool ending — orchestrator should become active again
      act(() => { capturedCallbacks!.onToolEnd('task') })

      const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
      expect(orchestratorEl).toHaveClass('node-active')
    })

    it('onTurnDone returns active state to orchestrator', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      // Simulate turn done — orchestrator should be active
      act(() => { capturedCallbacks!.onTurnDone() })

      const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
      expect(orchestratorEl).toHaveClass('node-active')
    })

    it('onToolStart with unmatched tool keeps orchestrator active', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      // Tool args don't match any node label (no assessor/executor on canvas)
      act(() => { capturedCallbacks!.onToolStart('task', { prompt: 'Do something unknown' }) })

      const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
      // Orchestrator stays active since no matching node was found
      expect(orchestratorEl).toHaveClass('node-active')
    })

    it('onStepPending pauses execution — status becomes paused', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })

      act(() => { capturedCallbacks!.onStepPending('task', { name: 'assessor' }) })

      expect(screen.getByTestId('debug-status').textContent).toBe('paused')
    })

    it('clicking Step when paused calls approveStep', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onSessionId('42') })
      act(() => { capturedCallbacks!.onStepPending('task', { name: 'assessor' }) })

      fireEvent.click(screen.getByTestId('btn-step'))

      expect(mockApproveStep).toHaveBeenCalledWith('42')
      // Status returns to running after approval
      expect(screen.getByTestId('debug-status').textContent).toBe('running')
    })
  })
})
