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
      <Handle type="target" position={Position.Top} data-testid="handle-target" />
      <Handle type="source" position={Position.Bottom} id="then" data-testid="handle-source-then" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="else" data-testid="handle-source-else" style={{ left: '70%' }} />
    </div>
  )
}
