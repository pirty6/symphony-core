import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { FrameNodeData, PhaseNodeData } from '../lib/model'

export type PhaseNodeType = Node<PhaseNodeData, 'phase'>

export function PhaseNode({ id, data, isConnectable }: NodeProps<PhaseNodeType>) {
  const cls = ['flow-node', 'phase-node', data.status ? `status-${data.status}` : ''].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      data-testid={`phase-${id}`}
      data-status={data.status ?? 'idle'}
      onDoubleClick={() => data.onExpand?.(id)}
      title={`${data.steps.join(' → ')}\n\nClick ⊕ to open this phase`}
    >
      <Handle isConnectable={isConnectable} type="target" position={Position.Top} />
      <div className="fn-header">
        <span className="fn-icon">▣</span>
        <span className="fn-title">{data.group.label}</span>
        {data.ran > 0 && <span className="fn-visits">{data.ran} run</span>}
        <button
          type="button"
          className="phase-toggle"
          aria-label={`open phase ${id}`}
          onClick={(e) => {
            e.stopPropagation()
            data.onExpand?.(id)
          }}
        >
          ⊕
        </button>
      </div>
      <div className="fn-kind">phase · {data.steps.length} steps</div>
      {data.group.description && <p className="fn-text">{data.group.description}</p>}
      {data.current && <div className="phase-current">▶ {data.current}</div>}
      {data.writes.length > 0 && (
        <div className="fn-chips">
          <span className="fn-chip-label">out</span>
          {data.writes.slice(0, 5).map((k) => (
            <span key={k} className="chip chip-out">
              {k}
            </span>
          ))}
          {data.writes.length > 5 && <span className="chip chip-more">+{data.writes.length - 5}</span>}
        </div>
      )}
      <Handle isConnectable={isConnectable} type="source" position={Position.Bottom} />
    </div>
  )
}

export type FrameNodeType = Node<FrameNodeData, 'frame'>

/** Box drawn behind the steps of an opened phase. */
export function FrameNode({ id, data }: NodeProps<FrameNodeType>) {
  const group = id.replace(/^frame:/, '')
  return (
    <div className="phase-frame" style={{ width: data.width, height: data.height }} data-testid={`frame-${group}`}>
      <div className="phase-frame-title">
        <span>▣ {data.label}</span>
        <button
          type="button"
          className="phase-toggle"
          aria-label={`close phase ${group}`}
          onClick={(e) => {
            e.stopPropagation()
            data.onCollapse?.(group)
          }}
        >
          ⊖
        </button>
      </div>
    </div>
  )
}
