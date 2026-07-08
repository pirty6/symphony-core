import { getSmoothStepPath, BaseEdge, useInternalNode, type EdgeProps } from '@xyflow/react'

const NODE_PADDING = 20

export function AvoidEdge(props: EdgeProps) {
  const sourceNode = useInternalNode(props.source)
  const targetNode = useInternalNode(props.target)

  const sourceWidth = sourceNode?.measured?.width ?? 180
  const targetWidth = targetNode?.measured?.width ?? 180
  const maxWidth = Math.max(sourceWidth, targetWidth)

  const dx = Math.abs(props.targetX - props.sourceX)
  const offset = dx < maxWidth ? maxWidth / 2 + NODE_PADDING : NODE_PADDING

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

  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      style={props.style}
    />
  )
}
