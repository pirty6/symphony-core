import { useState } from 'react'
import type { ExecutionState } from '../runtime'

export function DebugPanel({
  execution,
  onSendMessage,
}: {
  execution: ExecutionState
  onSendMessage?: (message: string) => void
}) {
  const [input, setInput] = useState('')

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || !onSendMessage) return
    onSendMessage(trimmed)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="debug-panel" data-testid="debug-panel">
      <div className="debug-header">
        <span className="debug-title">Debug</span>
        <span className={`debug-status debug-status-${execution.status}`} data-testid="debug-status">
          {execution.status}
        </span>
      </div>

      {execution.sdkPrompt && (
        <div className="debug-section">
          <div className="debug-section-title">Orchestrator Input</div>
          <pre className="debug-json debug-prompt" data-testid="debug-sdk-prompt">
            {execution.sdkPrompt}
          </pre>
        </div>
      )}

      {execution.sdkMessages.length > 0 && (
        <div className="debug-section">
          <div className="debug-section-title">SDK Messages</div>
          <div className="debug-messages" data-testid="debug-sdk-messages">
            {execution.sdkMessages.map((msg, i) => (
              <div key={i} className="debug-message">{msg}</div>
            ))}
          </div>
        </div>
      )}

      {execution.sdkSessionId && onSendMessage && (
        <div className="debug-section">
          <div className="debug-section-title">Send Message</div>
          <div className="debug-chat-input" data-testid="debug-chat-input">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message to the session..."
              rows={3}
              data-testid="debug-chat-field"
            />
            <button onClick={handleSend} disabled={!input.trim()} data-testid="debug-chat-send">
              Send
            </button>
          </div>
        </div>
      )}

      {Object.keys(execution.state).length > 0 && (
        <div className="debug-section">
          <div className="debug-section-title">State</div>
          <pre className="debug-json" data-testid="debug-state">
            {JSON.stringify(execution.state, null, 2)}
          </pre>
        </div>
      )}

      {execution.logs.length > 0 && (
        <div className="debug-section">
          <div className="debug-section-title">Steps</div>
          <div className="debug-logs" data-testid="debug-logs">
            {execution.logs.map((log, i) => (
              <div
                key={i}
                className={`debug-log-entry ${log.nodeId === execution.activeNodeId ? 'active' : ''}`}
              >
                <span className="debug-log-index">{i + 1}</span>
                <span className="debug-log-label">{log.label}</span>
                <span className="debug-log-type">{log.nodeType}</span>
                {log.prompt && (
                  <div className="debug-log-prompt">{log.prompt}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {execution.error && (
        <div className="debug-section">
          <div className="debug-error" data-testid="debug-error">{execution.error}</div>
        </div>
      )}
    </div>
  )
}
