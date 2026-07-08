import { useCallback, type ChangeEvent } from 'react'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'

type OrchestratorData = { label: string; description: string; prompt?: string }
type OrchestratorNode = Node<OrchestratorData, 'orchestrator'>

export function OrchestratorNode({ id, data }: NodeProps<OrchestratorNode>) {
  const { setNodes } = useReactFlow()

  const onPromptChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, prompt: e.target.value } } : n)),
      )
    },
    [id, setNodes],
  )

  return (
    <div className="workflow-node orchestrator">
      <div className="node-header">
        <div className="node-icon">🎼</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <textarea
        className="node-prompt"
        placeholder="Main prompt — what should this workflow accomplish?"
        value={data.prompt ?? ''}
        onChange={onPromptChange}
        data-testid="node-prompt"
      />
      <Handle type="source" position={Position.Bottom} data-testid="handle-source" />
    </div>
  )
}
