import type { ExecutionState } from '../runtime'

export function DebugPanel({ execution }: { execution: ExecutionState }) {
  return (
    <div className="debug-panel" data-testid="debug-panel">
      <div className="debug-header">
        <span className="debug-title">Debug</span>
        <span className={`debug-status debug-status-${execution.status}`} data-testid="debug-status">
          {execution.status}
        </span>
      </div>

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
