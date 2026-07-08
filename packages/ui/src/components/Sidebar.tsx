import { AGENT_ITEMS, CONTROL_ITEMS } from '../types'
import type { ExecutionState } from '../runtime'
import type { DragEvent } from 'react'

interface SidebarProps {
  onExport: () => void
  onRun: (debug: boolean) => void
  onStep?: () => void
  onResume?: () => void
  onStop?: () => void
  execution?: ExecutionState
}

export function Sidebar({ onExport, onRun, onStep, onResume, onStop, execution }: SidebarProps) {
  const status = execution?.status ?? 'idle'
  const isRunning = status === 'running' || status === 'paused'

  function onDragStart(event: DragEvent, nodeType: string) {
    event.dataTransfer.setData('application/reactflow', nodeType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="sidebar">
      <h2>Agents</h2>

      {AGENT_ITEMS.map((item) => (
        <div
          key={item.type}
          className={`sidebar-item ${item.type}`}
          draggable
          onDragStart={(e) => onDragStart(e, item.type)}
        >
          <div className="icon">{item.icon}</div>
          <div>
            <div>{item.label}</div>
            <div style={{ fontSize: 11, opacity: 0.5 }}>{item.description}</div>
          </div>
        </div>
      ))}

      <div className="sidebar-separator" role="separator" />

      <h2>Nodes</h2>

      {CONTROL_ITEMS.map((item) => (
        <div
          key={item.type}
          className={`sidebar-item ${item.type}`}
          draggable
          onDragStart={(e) => onDragStart(e, item.type)}
        >
          <div className="icon">{item.icon}</div>
          <div>
            <div>{item.label}</div>
            <div style={{ fontSize: 11, opacity: 0.5 }}>{item.description}</div>
          </div>
        </div>
      ))}

      <div className="sidebar-separator" role="separator" />

      <div className="sidebar-actions">
        {!isRunning ? (
          <div className="run-buttons">
            <button className="btn-debug" onClick={() => onRun(true)} data-testid="btn-debug" title="Run with debug panel">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M19.854 13.9605L13.2105 17.697C12.954 17.22 12.5505 16.8345 12.039 16.641L12.054 16.626L19.1175 12.6525C19.6275 12.366 19.6275 11.6325 19.1175 11.3445L7.11751 4.59599C6.61801 4.31399 6.00001 4.67549 6.00001 5.24999V10.5C5.46901 10.5 4.97401 10.6215 4.50001 10.791V5.24999C4.50001 3.52949 6.35251 2.44499 7.85251 3.28949L19.8525 10.0395C21.381 10.899 21.381 13.101 19.8525 13.962L19.854 13.9605ZM10.5 16.0605V18H11.25C11.664 18 12 18.336 12 18.75C12 19.164 11.664 19.5 11.25 19.5H10.5C10.5 20.076 10.3905 20.625 10.1925 21.132L11.781 22.7205C12.0735 23.013 12.0735 23.4885 11.781 23.781C11.634 23.928 11.442 24 11.25 24C11.058 24 10.866 23.9265 10.719 23.781L9.39151 22.4535C8.56651 23.4 7.35151 24.0015 6.00001 24.0015C4.64851 24.0015 3.43351 23.4015 2.60851 22.4535L1.28101 23.781C1.13401 23.928 0.942009 24 0.750009 24C0.558009 24 0.366009 23.9265 0.219009 23.781C-0.0734912 23.4885-0.0734912 23.013 0.219009 22.7205L1.80751 21.132C1.60951 20.625 1.50001 20.076 1.50001 19.5H0.750009C0.336009 19.5 0 19.164 0 18.75C0 18.336 0.336009 18 0.750009 18H1.50001V16.0605L0.219009 14.7795C-0.0734912 14.487-0.0734912 14.0115 0.219009 13.719C0.511509 13.4265 0.987009 13.4265 1.27951 13.719L2.56051 15H3.00001C3.00001 13.3455 4.34551 12 6.00001 12C7.65451 12 9.00001 13.3455 9.00001 15H9.43951L10.7205 13.719C11.013 13.4265 11.4885 13.4265 11.781 13.719C12.0735 14.0115 12.0735 14.487 11.781 14.7795L10.5 16.0605ZM4.50001 15H7.50001C7.50001 14.172 6.82801 13.5 6.00001 13.5C5.17201 13.5 4.50001 14.172 4.50001 15ZM9.00001 16.5H3.00001V19.5C3.00001 21.1545 4.34551 22.5 6.00001 22.5C7.65451 22.5 9.00001 21.1545 9.00001 19.5V16.5Z" /></svg>
            </button>
            <button className="btn-run" onClick={() => onRun(false)} data-testid="btn-run">
              ▶ Run Workflow
            </button>
          </div>
        ) : (
          <>
            {status === 'paused' && onResume && (
              <button className="btn-run" onClick={onResume} data-testid="btn-resume">
                ▶ Resume
              </button>
            )}
            {onStep && (
              <button className="btn-step" onClick={onStep} data-testid="btn-step">
                ⏭ Step
              </button>
            )}
            {onStop && (
              <button className="btn-stop" onClick={onStop} data-testid="btn-stop">
                ■ Stop
              </button>
            )}
          </>
        )}
        <button className="btn-export" onClick={onExport}>
          Export Workflow JSON
        </button>
      </div>
    </div>
  )
}
