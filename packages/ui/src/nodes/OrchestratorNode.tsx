import { useCallback, type ChangeEvent } from 'react'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import type { StateField } from '../types'

type OrchestratorData = { label: string; description: string; prompt?: string; stateFields?: StateField[] }
type OrchestratorNode = Node<OrchestratorData, 'orchestrator'>

export function OrchestratorNode({ id, data }: NodeProps<OrchestratorNode>) {
  const { setNodes } = useReactFlow()
  const stateFields = data.stateFields ?? []

  const onPromptChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, prompt: e.target.value } } : n)),
      )
    },
    [id, setNodes],
  )

  const updateFields = useCallback(
    (updater: (fields: StateField[]) => StateField[]) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n
          const current: StateField[] = (n.data.stateFields as StateField[] | undefined) ?? []
          return { ...n, data: { ...n.data, stateFields: updater(current) } }
        }),
      )
    },
    [id, setNodes],
  )

  const addField = useCallback(() => {
    updateFields((fields) => [...fields, { name: '', type: 'string' }])
  }, [updateFields])

  const removeField = useCallback(
    (index: number) => {
      updateFields((fields) => fields.filter((_, i) => i !== index))
    },
    [updateFields],
  )

  const onFieldChange = useCallback(
    (index: number, key: 'name' | 'type', value: string) => {
      updateFields((fields) =>
        fields.map((f, i) => (i === index ? { ...f, [key]: value } : f)),
      )
    },
    [updateFields],
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
      <div className="state-section" data-testid="state-section">
        <div className="state-header">
          <span className="state-label">State</span>
          <button className="state-add" onClick={addField} data-testid="state-add">+</button>
        </div>
        {stateFields.map((field, i) => (
          <div className="state-field" key={i} data-testid="state-field">
            <input
              className="state-field-name"
              placeholder="name"
              value={field.name}
              onChange={(e) => onFieldChange(i, 'name', e.target.value)}
              data-testid="state-field-name"
            />
            <select
              className="state-field-type"
              value={field.type}
              onChange={(e) => onFieldChange(i, 'type', e.target.value)}
              data-testid="state-field-type"
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="string[]">string[]</option>
              <option value="number[]">number[]</option>
              <option value="object">object</option>
            </select>
            <button className="state-field-remove" onClick={() => removeField(i)} data-testid="state-field-remove">×</button>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} data-testid="handle-source" />
    </div>
  )
}
