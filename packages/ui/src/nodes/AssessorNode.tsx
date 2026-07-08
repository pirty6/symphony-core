import { useCallback, type ChangeEvent } from 'react'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'

type AssessorData = { label: string; description: string; prompt?: string }
type AssessorNode = Node<AssessorData, 'assessor'>

export function AssessorNode({ id, data }: NodeProps<AssessorNode>) {
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
    <div className="workflow-node assessor">
      <div className="node-header">
        <div className="node-icon">🔍</div>
        <div className="node-title">{data.label}</div>
      </div>
      <div className="node-subtitle">{data.description}</div>
      <textarea
        className="node-prompt"
        placeholder="What should this assessor investigate?"
        value={data.prompt ?? ''}
        onChange={onPromptChange}
        data-testid="node-prompt"
      />
      <Handle type="target" position={Position.Top} data-testid="handle-target" />
      <Handle type="source" position={Position.Bottom} data-testid="handle-source" />
    </div>
  )
}
