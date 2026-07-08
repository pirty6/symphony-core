import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'

type AssessorData = { label: string; description: string }
type AssessorNode = Node<AssessorData, 'assessor'>

export function AssessorNode({ data }: NodeProps<AssessorNode>) {
  return (
    <div className="workflow-node assessor">
      <div className="node-header">
        <div className="node-icon">🔍</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
