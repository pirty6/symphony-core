import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'

type ConditionData = { label: string; description: string }
type ConditionNode = Node<ConditionData, 'condition'>

export function ConditionNode({ data }: NodeProps<ConditionNode>) {
  return (
    <div className="workflow-node condition">
      <div className="node-header">
        <div className="node-icon">◆</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} id="then" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="else" style={{ left: '70%' }} />
    </div>
  )
}
