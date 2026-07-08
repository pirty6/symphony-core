import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'

type OrchestratorData = { label: string; description: string }
type OrchestratorNode = Node<OrchestratorData, 'orchestrator'>

export function OrchestratorNode({ data }: NodeProps<OrchestratorNode>) {
  return (
    <div className="workflow-node orchestrator">
      <div className="node-header">
        <div className="node-icon">🎼</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <Handle type="source" position={Position.Bottom} data-testid="handle-source" />
    </div>
  )
}
