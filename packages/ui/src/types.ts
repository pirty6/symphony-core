export type InstrumentType = 'assessor' | 'executor'
export type ControlNodeType = 'end' | 'condition'
export type DraggableNodeType = InstrumentType | ControlNodeType

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
}

export const AGENT_ITEMS: PaletteItem[] = [
  {
    type: 'assessor',
    label: 'Assessor',
    description: 'Read-only evidence gatherer',
    icon: '🔍',
  },
  {
    type: 'executor',
    label: 'Executor',
    description: 'Write-focused change applier',
    icon: '⚡',
  },
]

export const CONTROL_ITEMS: PaletteItem[] = [
  {
    type: 'condition',
    label: 'If',
    description: 'Conditional branch (then/else)',
    icon: '◆',
  },
  {
    type: 'end',
    label: 'End',
    description: 'Terminal point of a path',
    icon: '⏹',
  },
]
