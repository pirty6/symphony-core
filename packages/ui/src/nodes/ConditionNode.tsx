import { useCallback, type ChangeEvent } from 'react'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'

type ConditionData = { label: string; description: string; prompt?: string }
type ConditionNode = Node<ConditionData, 'condition'>

export function ConditionNode({ id, data }: NodeProps<ConditionNode>) {
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
    <div className="workflow-node condition">
      <div className="node-header">
        <div className="node-icon">◆</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <textarea
        className="node-prompt"
        placeholder="Condition to evaluate"
        value={data.prompt ?? ''}
        onChange={onPromptChange}
        data-testid="node-prompt"
      />
      <div className="node-handles">
        <span data-testid="handle-label-true">true</span>
        <span data-testid="handle-label-false">false</span>
      </div>
      <Handle type="target" position={Position.Top} data-testid="handle-target" />
      <Handle type="source" position={Position.Bottom} id="then" data-testid="handle-source-then" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="else" data-testid="handle-source-else" style={{ left: '70%' }} />
    </div>
  )
}
