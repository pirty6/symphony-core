import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'

type ExecutorData = { label: string; description: string }
type ExecutorNode = Node<ExecutorData, 'executor'>

export function ExecutorNode({ data }: NodeProps<ExecutorNode>) {
  return (
    <div className="workflow-node executor">
      <div className="node-header">
        <div className="node-icon">⚡</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
