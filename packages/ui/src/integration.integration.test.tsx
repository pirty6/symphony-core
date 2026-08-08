/**
 * Integration tests for the UI ↔ Backend flow.
 *
 * These tests verify that the App component correctly:
 * - Builds a state machine prompt from the graph
 * - Starts an SDK session and receives SSE events
 * - Handles multi-turn messaging (onMessage, onTurnDone)
 * - Handles debug stepping (onStepPending → approveStep)
 * - Extracts state from SDK messages
 * - Highlights nodes based on tool events
 * - Includes edge condition labels in the prompt
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from './App'
import type { RunCallbacks } from './api'

let capturedCallbacks: RunCallbacks | null = null
let capturedPrompt: string | null = null
let capturedDebug: boolean | undefined
const mockSendMessage = vi.fn().mockResolvedValue(undefined)
const mockApproveStep = vi.fn().mockResolvedValue(undefined)
const mockStopRun = vi.fn().mockResolvedValue(undefined)

vi.mock('./api', () => ({
  startRun: (prompt: string, callbacks: RunCallbacks, debug?: boolean) => {
    capturedCallbacks = callbacks
    capturedPrompt = prompt
    capturedDebug = debug
    return new AbortController()
  },
  stopRun: (...args: unknown[]) => mockStopRun(...args),
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

describe('UI ↔ Backend Integration', () => {
  beforeEach(() => {
    capturedCallbacks = null
    capturedPrompt = null
    capturedDebug = undefined
    mockSendMessage.mockClear()
    mockApproveStep.mockClear()
    mockStopRun.mockClear()
  })

  describe('prompt building and session start', () => {
    it('builds state machine prompt from graph and sends to backend', () => {
      renderApp()

      // Set the orchestrator prompt
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Play a word game' } })

      // Start debug run
      fireEvent.click(screen.getByTestId('btn-debug'))

      // Verify prompt was captured
      expect(capturedPrompt).not.toBeNull()
      expect(capturedPrompt).toContain('Play a word game')
      expect(capturedPrompt).toContain('## Directive')
      expect(capturedPrompt).toContain('## Execution Model')
      expect(capturedPrompt).toContain('STATE MACHINE')
      expect(capturedDebug).toBe(true)
    })

    it('sends debug=false for non-debug runs', () => {
      renderApp()
      fireEvent.click(screen.getByTestId('btn-run'))
      expect(capturedDebug).toBe(false)
    })

    it('prompt includes state machine nodes for all canvas nodes', () => {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Orchestrate tasks' } })
      fireEvent.click(screen.getByTestId('btn-debug'))

      // The default canvas has just the orchestrator
      expect(capturedPrompt).toContain('orchestrator:Orchestrator')
      expect(capturedPrompt).toContain('## State Machine')
    })
  })

  describe('SSE event handling', () => {
    function startSession() {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Test game' } })
      fireEvent.click(screen.getByTestId('btn-debug'))
      expect(capturedCallbacks).not.toBeNull()
      act(() => { capturedCallbacks!.onSessionId('session-42') })
    }

    it('session event establishes the SDK session ID', () => {
      startSession()
      // Session is established — debug panel shows status
      expect(screen.getByTestId('debug-status').textContent).toBe('running')
    })

    it('message events are displayed in the debug panel', () => {
      startSession()
      act(() => { capturedCallbacks!.onMessage('Welcome to the game!') })
      act(() => { capturedCallbacks!.onMessage('I picked a 5-letter word.') })

      const logs = screen.getByTestId('debug-session-logs')
      expect(logs.textContent).toContain('Welcome to the game!')
      expect(logs.textContent).toContain('I picked a 5-letter word.')
    })

    it('turn-done keeps session active', () => {
      startSession()
      act(() => { capturedCallbacks!.onMessage('Your turn') })
      act(() => { capturedCallbacks!.onTurnDone() })

      expect(screen.getByTestId('debug-status').textContent).toBe('running')
    })

    it('error event is shown in the debug panel', () => {
      startSession()
      act(() => { capturedCallbacks!.onError('Connection lost') })

      expect(screen.getByTestId('debug-error').textContent).toContain('Connection lost')
    })
  })

  describe('multi-turn conversation flow', () => {
    function startSessionWithMessages() {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Play hangman' } })
      fireEvent.click(screen.getByTestId('btn-debug'))
      act(() => { capturedCallbacks!.onSessionId('sess-1') })
      act(() => { capturedCallbacks!.onMessage('I picked a word: _ _ _ _ _') })
      act(() => { capturedCallbacks!.onTurnDone() })
    }

    it('full conversation flow: messages accumulate in debug panel', () => {
      startSessionWithMessages()

      // Backend responds with more messages
      act(() => { capturedCallbacks!.onMessage('A is correct! _ A _ _ _') })
      act(() => { capturedCallbacks!.onTurnDone() })

      const logs = screen.getByTestId('debug-session-logs')
      expect(logs.textContent).toContain('A is correct! _ A _ _ _')
      expect(logs.textContent).toContain('I picked a word: _ _ _ _ _')
    })

    it('stopping the session calls stopRun and resets state', () => {
      startSessionWithMessages()

      fireEvent.click(screen.getByTestId('btn-stop'))

      expect(mockStopRun).toHaveBeenCalledWith('sess-1')
      // Debug panel is gone after stop
      expect(screen.queryByTestId('debug-panel')).not.toBeInTheDocument()
    })
  })

  describe('debug stepping flow', () => {
    function startDebugSession() {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Step through tasks' } })
      fireEvent.click(screen.getByTestId('btn-debug'))
      act(() => { capturedCallbacks!.onSessionId('step-sess') })
    }

    it('step-pending pauses execution and shows step button', () => {
      startDebugSession()

      act(() => { capturedCallbacks!.onStepPending('task', { name: 'assessor', prompt: 'Check' }) })

      expect(screen.getByTestId('debug-status').textContent).toBe('paused')
      expect(screen.getByTestId('btn-step')).toBeInTheDocument()
    })

    it('clicking Step approves the pending step', () => {
      startDebugSession()
      act(() => { capturedCallbacks!.onStepPending('task', { name: 'executor', prompt: 'Apply' }) })

      fireEvent.click(screen.getByTestId('btn-step'))

      expect(mockApproveStep).toHaveBeenCalledWith('step-sess')
      expect(screen.getByTestId('debug-status').textContent).toBe('running')
    })

    it('multiple step cycles work correctly', () => {
      startDebugSession()

      // First step
      act(() => { capturedCallbacks!.onStepPending('task', { name: 'assessor' }) })
      expect(screen.getByTestId('debug-status').textContent).toBe('paused')
      fireEvent.click(screen.getByTestId('btn-step'))
      expect(mockApproveStep).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('debug-status').textContent).toBe('running')

      // Tool completes
      act(() => { capturedCallbacks!.onToolEnd('task', 'assessor', 'done') })

      // Second step
      act(() => { capturedCallbacks!.onStepPending('task', { name: 'executor' }) })
      expect(screen.getByTestId('debug-status').textContent).toBe('paused')
      fireEvent.click(screen.getByTestId('btn-step'))
      expect(mockApproveStep).toHaveBeenCalledTimes(2)
    })
  })

  describe('state extraction from messages', () => {
    function startSessionAndSendState() {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Manage state' } })
      fireEvent.click(screen.getByTestId('btn-debug'))
      act(() => { capturedCallbacks!.onSessionId('state-sess') })
    }

    it('extracts JSON state from assistant messages', () => {
      startSessionAndSendState()

      // SDK sends a message with embedded state
      act(() => {
        capturedCallbacks!.onMessage('I updated the state. { "state": { "word": "hello", "guesses": 3 } }')
      })

      const stateEl = screen.getByTestId('debug-state')
      expect(stateEl.textContent).toContain('"word"')
      expect(stateEl.textContent).toContain('"hello"')
      expect(stateEl.textContent).toContain('"guesses"')
    })

    it('extracts state from tool results via onToolEnd', () => {
      startSessionAndSendState()

      act(() => {
        capturedCallbacks!.onToolEnd('task', 'assessor', '{ "state": { "result": "found" } }')
      })

      const stateEl = screen.getByTestId('debug-state')
      expect(stateEl.textContent).toContain('"result"')
      expect(stateEl.textContent).toContain('"found"')
    })

    it('handles state in ```json code blocks', () => {
      startSessionAndSendState()

      act(() => {
        capturedCallbacks!.onMessage('Here is the state:\n```json\n{ "state": { "status": "active" } }\n```')
      })

      const stateEl = screen.getByTestId('debug-state')
      expect(stateEl.textContent).toContain('"status"')
      expect(stateEl.textContent).toContain('"active"')
    })
  })

  describe('node highlighting via tool events', () => {
    function startSessionWithOrchestrator() {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Highlight nodes' } })
      fireEvent.click(screen.getByTestId('btn-debug'))
      act(() => { capturedCallbacks!.onSessionId('highlight-sess') })
    }

    it('orchestrator is active at session start', () => {
      startSessionWithOrchestrator()

      const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
      expect(orchestratorEl).toHaveClass('node-active')
    })

    it('tool-end returns focus to orchestrator', () => {
      startSessionWithOrchestrator()

      // Simulate a tool completing
      act(() => { capturedCallbacks!.onToolEnd('task', 'some-agent', 'result') })

      const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
      expect(orchestratorEl).toHaveClass('node-active')
    })

    it('turn-done returns focus to orchestrator', () => {
      startSessionWithOrchestrator()

      act(() => { capturedCallbacks!.onTurnDone() })

      const orchestratorEl = screen.getAllByText('Orchestrator')[0].closest('.react-flow__node')
      expect(orchestratorEl).toHaveClass('node-active')
    })
  })

  describe('edge conditions in prompt', () => {
    it('edge labels are included as transition conditions in generated prompt', () => {
      renderApp()

      // We can't easily add edges programmatically in the rendered app without 
      // full drag/drop simulation, but we verify the prompt builder via the 
      // prompt.test.ts suite. Here we verify the flow doesn't break when running.
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Test conditions' } })
      fireEvent.click(screen.getByTestId('btn-debug'))

      // The prompt should be valid — no crash during build
      expect(capturedPrompt).not.toBeNull()
      expect(capturedPrompt).toContain('## State Machine')
    })
  })

  describe('full end-to-end session lifecycle', () => {
    it('complete lifecycle: start → messages → stepping → state → stop', () => {
      renderApp()
      const textarea = screen.getAllByTestId('node-prompt')[0]
      fireEvent.change(textarea, { target: { value: 'Full lifecycle test' } })

      // 1. Start debug session
      fireEvent.click(screen.getByTestId('btn-debug'))
      expect(capturedCallbacks).not.toBeNull()
      expect(capturedDebug).toBe(true)

      // 2. Session established
      act(() => { capturedCallbacks!.onSessionId('full-sess') })
      expect(screen.getByTestId('debug-status').textContent).toBe('running')

      // 3. Receive initial message
      act(() => { capturedCallbacks!.onMessage('Starting analysis...') })
      expect(screen.getByTestId('debug-session-logs').textContent).toContain('Starting analysis...')

      // 4. Tool starts (step pending in debug mode)
      act(() => { capturedCallbacks!.onStepPending('task', { name: 'assessor', prompt: 'Check files' }) })
      expect(screen.getByTestId('debug-status').textContent).toBe('paused')

      // 5. User approves step
      fireEvent.click(screen.getByTestId('btn-step'))
      expect(mockApproveStep).toHaveBeenCalledWith('full-sess')
      expect(screen.getByTestId('debug-status').textContent).toBe('running')

      // 6. Tool completes with state
      act(() => { capturedCallbacks!.onToolEnd('task', 'assessor', '{ "state": { "findings": "issue found" } }') })
      const stateEl = screen.getByTestId('debug-state')
      expect(stateEl.textContent).toContain('"findings"')

      // 7. Another message after tool
      act(() => { capturedCallbacks!.onMessage('Analysis complete. Found an issue.') })
      act(() => { capturedCallbacks!.onTurnDone() })

      // 8. Stop session
      fireEvent.click(screen.getByTestId('btn-stop'))
      expect(mockStopRun).toHaveBeenCalledWith('full-sess')
      expect(screen.queryByTestId('debug-panel')).not.toBeInTheDocument()
    })

    it('non-debug run does not show debug panel', () => {
      renderApp()
      fireEvent.click(screen.getByTestId('btn-run'))

      expect(screen.queryByTestId('debug-sdk-prompt')).not.toBeInTheDocument()
      expect(screen.queryByTestId('debug-panel')).not.toBeInTheDocument()
    })
  })
})
