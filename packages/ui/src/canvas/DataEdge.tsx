import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import type { FlowEdge } from '../lib/model'

const MAX_CHIPS = 3

function preview(values: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(values)
  return text.length > 140 ? `${text.slice(0, 137)}…` : text
}

const NODE_HALF_WIDTH = 115

/** Loops go back up along the right side so they never cross the nodes they skip. */
function loopPath(sx: number, sy: number, tx: number, ty: number): [string, number, number] {
  const rx = Math.max(sx, tx) + NODE_HALF_WIDTH + 30 + Math.min(80, Math.abs(sy - ty) / 12)
  const down = sy + 18
  const up = ty - 18
  return [`M ${sx} ${sy} L ${sx} ${down} L ${rx} ${down} L ${rx} ${up} L ${tx} ${up} L ${tx} ${ty}`, rx, (down + up) / 2]
}

export function DataEdge(props: EdgeProps<FlowEdge>) {
  const { id, data, markerEnd, selected } = props
  const [path, labelX, labelY] = data?.back
    ? loopPath(props.sourceX, props.sourceY, props.targetX, props.targetY)
    : getSmoothStepPath({
        sourceX: props.sourceX,
        sourceY: props.sourceY,
        targetX: props.targetX,
        targetY: props.targetY,
        sourcePosition: props.sourcePosition,
        targetPosition: props.targetPosition,
        offset: 20,
        borderRadius: 10,
      })
  const edge = data?.edge
  const label =
    edge?.label ?? edge?.guard ?? (edge?.branch === 'then' || edge?.branch === 'else' ? undefined : edge?.branch)
  const carries = data?.carries ?? []
  const count = data?.count ?? 0
  const cls = [
    'data-edge',
    data?.active ? 'active' : '',
    data?.back ? 'back' : '',
    count > 0 ? 'visited' : '',
    data?.issues?.length ? 'has-issues' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <g className={cls}>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} interactionWidth={16} />
      {data?.active && (
        <circle r={6} className="packet" data-testid={`packet-${id}`}>
          <animateMotion dur="1.2s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      <EdgeLabelRenderer>
        <div
          className={`edge-label ${cls}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          data-testid={`edge-label-${id}`}
          title={data?.issues?.join('\n') ?? (edge?.guard ? `guard: ${edge.guard}` : undefined)}
        >
          {label && <span className="el-guard">{label}</span>}
          {carries.length > 0 && (
            <span className="el-carries">
              {carries.slice(0, MAX_CHIPS).map((k) => (
                <span key={k} className="chip chip-data">
                  {k}
                </span>
              ))}
              {carries.length > MAX_CHIPS && <span className="chip chip-more">+{carries.length - MAX_CHIPS}</span>}
            </span>
          )}
          {count > 0 && <span className="el-count">×{count}</span>}
          {data?.active && data.values && Object.keys(data.values).length > 0 && (
            <pre className="el-values" data-testid={`edge-values-${id}`}>
              {preview(data.values)}
            </pre>
          )}
        </div>
      </EdgeLabelRenderer>
    </g>
  )
}
