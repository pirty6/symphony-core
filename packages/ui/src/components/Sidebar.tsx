import { AGENT_ITEMS, CONTROL_ITEMS } from '../types'
import type { DragEvent } from 'react'

export function Sidebar({ onExport }: { onExport: () => void }) {
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

      <div className="sidebar-separator" />

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

      <div className="sidebar-separator" />

      <div className="sidebar-actions">
        <button className="btn-export" onClick={onExport}>
          Export Workflow JSON
        </button>
      </div>
    </div>
  )
}
