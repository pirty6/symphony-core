import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DebugPanel } from './DebugPanel'
import { createInitialExecutionState, type ExecutionState, type SessionLogEntry } from '../runtime'

function makeExecution(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return { ...createInitialExecutionState(true), status: 'running', ...overrides }
}

function makeLog(overrides: Partial<SessionLogEntry>): SessionLogEntry {
  return { type: 'orchestrator', timestamp: Date.now(), content: 'test', ...overrides }
}

describe('DebugPanel', () => {
  it('renders status badge', () => {
    render(<DebugPanel execution={makeExecution({ status: 'paused' })} />)
    expect(screen.getByTestId('debug-status').textContent).toBe('paused')
  })

  it('shows orchestrator input when sdkPrompt is set', () => {
    render(<DebugPanel execution={makeExecution({ sdkPrompt: 'You are the game controller' })} />)
    expect(screen.getByTestId('debug-sdk-prompt').textContent).toContain('game controller')
  })

  it('hides orchestrator input when sdkPrompt is null', () => {
    render(<DebugPanel execution={makeExecution({ sdkPrompt: null })} />)
    expect(screen.queryByTestId('debug-sdk-prompt')).not.toBeInTheDocument()
  })

  it('hides session activity when no logs exist', () => {
    render(<DebugPanel execution={makeExecution({ sessionLogs: [] })} />)
    expect(screen.queryByTestId('debug-session-logs')).not.toBeInTheDocument()
  })

  describe('session log rendering', () => {
    it('renders orchestrator log with brain icon', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [makeLog({ type: 'orchestrator', agent: 'Orchestrator', content: 'Thinking about next move' })],
      })} />)

      const entry = screen.getByTestId('session-log-entry')
      expect(entry).toHaveClass('session-log-orchestrator')
      expect(entry.textContent).toContain('🧠')
      expect(entry.textContent).toContain('Orchestrator')
      expect(entry.textContent).toContain('Thinking about next move')
    })

    it('renders tool-start log with play icon and prompt details', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [makeLog({
          type: 'tool-start',
          agent: 'Pick Word',
          content: 'Calling Pick Word',
          details: 'Pick a random 5-letter word',
        })],
      })} />)

      const entry = screen.getByTestId('session-log-entry')
      expect(entry).toHaveClass('session-log-tool-start')
      expect(entry.textContent).toContain('▶')
      expect(entry.textContent).toContain('Pick Word')
      expect(entry.textContent).toContain('Pick a random 5-letter word')
    })

    it('renders tool-end log with check icon and result details', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [makeLog({
          type: 'tool-end',
          agent: 'Pick Word',
          content: 'Pick Word completed',
          details: 'The word is "hello"',
        })],
      })} />)

      const entry = screen.getByTestId('session-log-entry')
      expect(entry).toHaveClass('session-log-tool-end')
      expect(entry.textContent).toContain('✓')
      expect(entry.textContent).toContain('Pick Word completed')
      expect(entry.textContent).toContain('The word is "hello"')
    })

    it('renders state-change log with chart icon', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [makeLog({
          type: 'state-change',
          content: 'State updated by assessor',
          details: '{ "word": "hello" }',
        })],
      })} />)

      const entry = screen.getByTestId('session-log-entry')
      expect(entry).toHaveClass('session-log-state-change')
      expect(entry.textContent).toContain('📊')
      expect(entry.textContent).toContain('State updated by assessor')
      expect(entry.textContent).toContain('"word": "hello"')
    })

    it('renders error log with warning icon', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [makeLog({ type: 'error', content: 'Token expired' })],
      })} />)

      const entry = screen.getByTestId('session-log-entry')
      expect(entry).toHaveClass('session-log-error')
      expect(entry.textContent).toContain('⚠')
      expect(entry.textContent).toContain('Token expired')
    })

    it('does not render details element when details is undefined', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [makeLog({ type: 'orchestrator', content: 'Hello' })],
      })} />)

      expect(screen.queryByRole('log')).not.toBeInTheDocument()
      const entry = screen.getByTestId('session-log-entry')
      expect(entry.querySelector('.session-log-details')).toBeNull()
    })

    it('renders multiple log entries in order', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [
          makeLog({ type: 'orchestrator', content: 'Starting game' }),
          makeLog({ type: 'tool-start', agent: 'Pick Word', content: 'Calling Pick Word' }),
          makeLog({ type: 'tool-end', agent: 'Pick Word', content: 'Pick Word completed' }),
          makeLog({ type: 'state-change', content: 'State updated' }),
          makeLog({ type: 'orchestrator', content: 'Your turn!' }),
        ],
      })} />)

      const entries = screen.getAllByTestId('session-log-entry')
      expect(entries).toHaveLength(5)
      expect(entries[0]).toHaveClass('session-log-orchestrator')
      expect(entries[1]).toHaveClass('session-log-tool-start')
      expect(entries[2]).toHaveClass('session-log-tool-end')
      expect(entries[3]).toHaveClass('session-log-state-change')
      expect(entries[4]).toHaveClass('session-log-orchestrator')
    })

    it('omits agent span when agent is not provided', () => {
      render(<DebugPanel execution={makeExecution({
        sessionLogs: [makeLog({ type: 'state-change', agent: undefined, content: 'State updated' })],
      })} />)

      const entry = screen.getByTestId('session-log-entry')
      expect(entry.querySelector('.session-log-agent')).toBeNull()
    })
  })

  describe('state display', () => {
    it('shows state section when state has entries', () => {
      render(<DebugPanel execution={makeExecution({ state: { word: 'hello', wrongCount: 2 } })} />)
      const stateEl = screen.getByTestId('debug-state')
      expect(stateEl.textContent).toContain('"word"')
      expect(stateEl.textContent).toContain('"wrongCount"')
    })

    it('hides state section when state is empty', () => {
      render(<DebugPanel execution={makeExecution({ state: {} })} />)
      expect(screen.queryByTestId('debug-state')).not.toBeInTheDocument()
    })
  })

  describe('error display', () => {
    it('shows error section when error is set', () => {
      render(<DebugPanel execution={makeExecution({ error: 'Connection lost' })} />)
      expect(screen.getByTestId('debug-error').textContent).toBe('Connection lost')
    })

    it('hides error section when error is null', () => {
      render(<DebugPanel execution={makeExecution({ error: null })} />)
      expect(screen.queryByTestId('debug-error')).not.toBeInTheDocument()
    })
  })
})
