export type InstrumentType = 'assessor' | 'executor'
export type ControlNodeType = 'end' | 'condition'
export type DraggableNodeType = InstrumentType | ControlNodeType
export type NodeType = DraggableNodeType | 'orchestrator'

export type MaxEdges = 0 | 1

export function isDraggableNodeType(value: string): value is DraggableNodeType {
  return value === 'assessor' || value === 'executor' || value === 'end' || value === 'condition'
}

export interface WorkflowNode {
  id: string
  type: DraggableNodeType | 'orchestrator'
  label: string
  description?: string
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
}

export interface Workflow {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface PaletteItem {
  type: DraggableNodeType
  label: string
  description: string
  icon: string
  maxEdges: MaxEdges
}

export const AGENT_ITEMS: PaletteItem[] = [
  {
    type: 'assessor',
    label: 'Assessor',
    description: 'Read-only evidence gatherer',
    icon: '🔍',
    maxEdges: 1,
  },
  {
    type: 'executor',
    label: 'Executor',
    description: 'Write-focused change applier',
    icon: '⚡',
    maxEdges: 1,
  },
]

export const CONTROL_ITEMS: PaletteItem[] = [
  {
    type: 'condition',
    label: 'If',
    description: 'Conditional branch (then/else)',
    icon: '◆',
    maxEdges: 1,
  },
  {
    type: 'end',
    label: 'End',
    description: 'Terminal point of a path',
    icon: '⏹',
    maxEdges: 0,
  },
]
