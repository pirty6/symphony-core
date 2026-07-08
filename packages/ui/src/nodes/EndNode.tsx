import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'

type EndData = { label: string; description: string }
type EndNode = Node<EndData, 'end'>

export function EndNode({ data }: NodeProps<EndNode>) {
  return (
    <div className="workflow-node end">
      <div className="node-header">
        <div className="node-icon">⏹</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <Handle type="target" position={Position.Top} data-testid="handle-target" />
    </div>
  )
}
