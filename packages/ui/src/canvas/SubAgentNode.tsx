import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { SubAgentNodeData } from '../lib/model'

export type SubAgentNodeType = Node<SubAgentNodeData, 'subagent'>

const LABEL: Record<SubAgentNodeData['state'], string> = {
  waiting: 'waiting for a slot',
  running: 'running',
  done: 'answered',
  failed: 'no answer',
  kept: 'kept from last attempt',
}
const STATUS: Partial<Record<SubAgentNodeData['state'], string>> = { running: 'active', done: 'done', failed: 'failed', kept: 'done' }

/** One sub-agent of a fanned-out step: what it reads and how it is doing. */
export function SubAgentNode({ data }: NodeProps<SubAgentNodeType>) {
  const status = STATUS[data.state]
  return (
    <div
      className={['flow-node', 'subagent-node', status ? `status-${status}` : '', `subagent-${data.state}`].filter(Boolean).join(' ')}
      data-testid={`subagent-${data.part}`}
      data-state={data.state}
      title={`Sub-agent ${data.part} of ${data.total} of “${data.parent}”: ${LABEL[data.state]}. Click to see its output.`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="fn-header">
        <span className="fn-icon">🤖</span>
        <span className="fn-title">
          Sub-agent {data.part}/{data.total}
        </span>
      </div>
      <div className="fn-kind">
        {LABEL[data.state]}
        {data.item ? ` · ${data.item}` : ''}
      </div>
    </div>
  )
}
