import type { ExecutionState, SessionLogEntry } from '../runtime'

function LogIcon({ type }: { type: SessionLogEntry['type'] }) {
  switch (type) {
    case 'orchestrator': return <span className="log-icon">🧠</span>
    case 'tool-start': return <span className="log-icon">▶</span>
    case 'tool-end': return <span className="log-icon">✓</span>
    case 'state-change': return <span className="log-icon">📊</span>
    case 'error': return <span className="log-icon">⚠</span>
  }
}

export function DebugPanel({
  execution,
}: {
  execution: ExecutionState
}) {
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

      {execution.sessionLogs.length > 0 && (
        <div className="debug-section">
          <div className="debug-section-title">Session Activity</div>
          <div className="debug-session-logs" data-testid="debug-session-logs">
            {execution.sessionLogs.map((entry, i) => (
              <div key={i} className={`session-log-entry session-log-${entry.type}`} data-testid="session-log-entry">
                <div className="session-log-header">
                  <LogIcon type={entry.type} />
                  {entry.agent && <span className="session-log-agent">{entry.agent}</span>}
                  <span className="session-log-content">{entry.content}</span>
                </div>
                {entry.details && (
                  <pre className="session-log-details">{entry.details}</pre>
                )}
              </div>
            ))}
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

      {execution.error && (
        <div className="debug-section">
          <div className="debug-error" data-testid="debug-error">{execution.error}</div>
        </div>
      )}
    </div>
  )
}
