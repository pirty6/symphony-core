import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'

type ApprovalData = { label: string; description: string }
type ApprovalNode = Node<ApprovalData, 'approval'>

export function ApprovalNode({ data }: NodeProps<ApprovalNode>) {
  return (
    <div className="workflow-node approval">
      <div className="node-header">
        <div className="node-icon">✋</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <Handle type="target" position={Position.Top} data-testid="handle-target" />
      <Handle type="source" position={Position.Bottom} data-testid="handle-source" />
    </div>
  )
}
