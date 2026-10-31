import { Handle, Position, type NodeProps } from '@xyflow/react'
import { KIND_LABEL, ORIGIN_LABEL, type FlowNode as FlowNodeType } from '../lib/model'

const ICON: Record<string, string> = {
  start: '▶',
  assessor: '🔍',
  executor: '⚡',
  compute: 'ƒ',
  condition: '◆',
  approval: '✋',
  end: '⏹',
  tool: '⚙',
}

function Chips({ label, keys }: { label: string; keys: readonly string[] }) {
  if (keys.length === 0) return null
  return (
    <div className="fn-chips">
      <span className="fn-chip-label">{label}</span>
      {keys.map((k) => (
        <span key={k} className={`chip chip-${label}`}>
          {k}
        </span>
      ))}
    </div>
  )
}

export function FlowNode({ id, data, selected, isConnectable }: NodeProps<FlowNodeType>) {
  const n = data.node
  const kindKey = n.kind === 'agent' ? n.role : n.kind
  const cls = [
    'flow-node',
    `kind-${kindKey}`,
    data.status ? `status-${data.status}` : '',
    data.issues?.length ? 'has-issues' : '',
    selected ? 'selected' : '',
    data.gate ? 'at-gate' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} data-testid={`node-${id}`} data-status={data.status ?? 'idle'} title={data.issues?.join('\n')}>
      {n.kind !== 'start' && <Handle isConnectable={isConnectable} type="target" position={Position.Top} />}
      <div className="fn-header">
        <span className="fn-icon">{ICON[kindKey]}</span>
        <span className="fn-title">{n.label}</span>
        {data.visits ? (
          <span className="fn-visits" title="times entered">
            ×{data.visits}
          </span>
        ) : null}
        {n.kind !== 'start' && n.kind !== 'end' && (
          <button
            type="button"
            className={`fn-bp${data.breakpoint ? ' on' : ''}`}
            title={data.breakpoint ? 'Remove breakpoint' : 'Pause here (breakpoint)'}
            aria-label={`breakpoint ${id}`}
            aria-pressed={data.breakpoint ?? false}
            onClick={(e) => {
              e.stopPropagation()
              data.onToggleBreakpoint?.(id)
            }}
          />
        )}
      </div>
      <div className="fn-kind">
        {n.kind === 'agent' ? `${n.role} · AI` : KIND_LABEL[n.kind]} · <code>{id}</code>
      </div>
      {data.origin && n.kind === 'agent' && (
        <div className={`fn-origin origin-${data.origin.origin}`} title={data.origin.detail} data-testid={`origin-${id}`}>
          {ORIGIN_LABEL[data.origin.origin]}
        </div>
      )}
      {n.kind === 'agent' && (
        <>
          <p className="fn-text">{n.directive}</p>
          <Chips label="in" keys={data.reads} />
          <Chips label="out" keys={data.writes} />
          {n.capabilities?.length || n.checks?.length || n.solo || n.isolated || n.complexity ? (
            <div className="fn-badges">
              {n.solo && <span className="badge badge-solo" title="Solo point: from Swing up the AI chooses the route">🎷 solo</span>}
              {n.isolated && <span className="badge" title="No workspace tools: works only from its input">🔒 isolated</span>}
              {n.complexity && <span className="badge" title="Fixed model tier">tier {n.complexity}</span>}
              {n.capabilities?.includes('web') && <span className="badge" title="May search and read the web">🌐 web</span>}
              {n.capabilities?.includes('mcp') && <span className="badge" title="May use MCP servers">🔌 mcp</span>}
              {n.checks?.length ? (
                <span className="badge badge-check" title={n.checks.map((c) => `${c.expr} — ${c.message}`).join('\n')}>
                  ✓ {n.checks.length} check{n.checks.length > 1 ? 's' : ''}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {n.kind === 'tool' && (
        <>
          <code className="fn-expr">{n.tool}</code>
          <Chips label="out" keys={data.writes} />
        </>
      )}
      {n.kind === 'compute' && (
        <ul className="fn-assign">
          {n.assign.map((a, i) => (
            <li key={i} title={`${a.field} = ${a.expr}`}>
              <b>{a.field}</b> ← <code>{a.expr}</code>
            </li>
          ))}
        </ul>
      )}
      {n.kind === 'condition' && <code className="fn-expr">{n.expression}</code>}
      {n.kind === 'approval' && (
        <>
          <p className="fn-text">{n.message}</p>
          <Chips label="out" keys={data.writes} />
        </>
      )}
      {n.kind === 'end' && <div className={`fn-outcome outcome-${n.outcome ?? 'success'}`}>{n.outcome ?? 'success'}</div>}
      {data.gate && (
        <div className="fn-gate">{data.gate === 'before' ? '⏸ paused before running' : '⏸ AI answered: review before applying'}</div>
      )}
      {n.kind === 'condition' ? (
        <>
          <Handle isConnectable={isConnectable} type="source" id="then" position={Position.Bottom} style={{ left: '28%' }} />
          <Handle isConnectable={isConnectable} type="source" id="else" position={Position.Bottom} style={{ left: '72%' }} />
          <div className="fn-branches">
            <span>then</span>
            <span>else</span>
          </div>
        </>
      ) : n.kind === 'approval' ? (
        <>
          <Handle isConnectable={isConnectable} type="source" id="approved" position={Position.Bottom} style={{ left: '28%' }} />
          <Handle isConnectable={isConnectable} type="source" id="rejected" position={Position.Bottom} style={{ left: '72%' }} />
          <div className="fn-branches">
            <span>approved</span>
            <span>rejected</span>
          </div>
        </>
      ) : n.kind !== 'end' ? (
        <Handle isConnectable={isConnectable} type="source" position={Position.Bottom} />
      ) : null}
    </div>
  )
}
