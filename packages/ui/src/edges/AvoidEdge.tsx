import { getSmoothStepPath, BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react'

const NODE_PADDING = 20

export function AvoidEdge(props: EdgeProps) {
  const sourceNode = useInternalNode(props.source)
  const targetNode = useInternalNode(props.target)

  const sourceWidth = sourceNode?.measured?.width ?? 180
  const targetWidth = targetNode?.measured?.width ?? 180
  const maxWidth = Math.max(sourceWidth, targetWidth)

  const dx = Math.abs(props.targetX - props.sourceX)
  const targetBelow = props.targetY > props.sourceY

  // Only apply avoidance offset when the edge must route around a node
  // (nodes overlap horizontally AND target is not cleanly below source)
  const offset = dx < maxWidth && !targetBelow ? maxWidth / 2 + NODE_PADDING : NODE_PADDING

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    offset,
    borderRadius: 8,
  })

  const label = props.data?.label as string | undefined

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={props.style}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            data-testid={`edge-label-${props.id}`}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
