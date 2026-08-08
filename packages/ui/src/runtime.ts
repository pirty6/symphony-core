import type { StateField } from './types'

export type ExecutionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error'

export interface StepLog {
  nodeId: string
  nodeType: string
  label: string
  prompt: string
  state: Record<string, unknown>
  timestamp: number
}

export interface ExecutionState {
  status: ExecutionStatus
  activeNodeId: string | null
  visitedNodeIds: string[]
  state: Record<string, unknown>
  logs: StepLog[]
  error: string | null
  debug: boolean
  /** The prompt sent to the Copilot SDK session (populated on run) */
  sdkPrompt: string | null
  /** Messages received from the SDK session */
  sdkMessages: string[]
  /** Active session ID for stopping */
  sdkSessionId: string | null
}

export function createInitialExecutionState(debug: boolean): ExecutionState {
  return {
    status: 'idle',
    activeNodeId: null,
    visitedNodeIds: [],
    state: {},
    logs: [],
    error: null,
    debug,
    sdkPrompt: null,
    sdkMessages: [],
    sdkSessionId: null,
  }
}

interface GraphNode {
  id: string
  type?: string
  data: Record<string, unknown>
}

interface GraphEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
}

export function buildInitialState(stateFields: StateField[]): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const field of stateFields) {
    switch (field.type) {
      case 'string':
        state[field.name] = ''
        break
      case 'number':
        state[field.name] = 0
        break
      case 'boolean':
        state[field.name] = false
        break
      case 'string[]':
      case 'number[]':
        state[field.name] = []
        break
      case 'object':
        state[field.name] = {}
        break
      default:
        state[field.name] = null
    }
  }
  return state
}

export function findNextNodes(
  currentNodeId: string,
  edges: GraphEdge[],
  sourceHandle?: string | null,
): string[] {
  return edges
    .filter((e) => {
      if (e.source !== currentNodeId) return false
      if (sourceHandle != null) return e.sourceHandle === sourceHandle
      return true
    })
    .map((e) => e.target)
}

export function findOrchestratorNode(nodes: GraphNode[]): GraphNode | undefined {
  return nodes.find((n) => n.type === 'orchestrator')
}

export function walkStep(
  execution: ExecutionState,
  nodes: GraphNode[],
  edges: GraphEdge[],
): ExecutionState {
  const { activeNodeId } = execution

  if (activeNodeId === null) {
    const orchestrator = findOrchestratorNode(nodes)
    if (!orchestrator) {
      return { ...execution, status: 'error', error: 'No orchestrator node found' }
    }

    const stateFields = (orchestrator.data.stateFields as StateField[] | undefined) ?? []
    const initialState = buildInitialState(stateFields)

    const log: StepLog = {
      nodeId: orchestrator.id,
      nodeType: orchestrator.type ?? 'unknown',
      label: String(orchestrator.data.label ?? ''),
      prompt: String(orchestrator.data.prompt ?? ''),
      state: initialState,
      timestamp: Date.now(),
    }

    return {
      ...execution,
      status: 'running',
      activeNodeId: orchestrator.id,
      visitedNodeIds: [orchestrator.id],
      state: initialState,
      logs: [...execution.logs, log],
    }
  }

  const currentNode = nodes.find((n) => n.id === activeNodeId)
  if (!currentNode) {
    return { ...execution, status: 'error', error: `Node ${activeNodeId} not found` }
  }

  if (currentNode.type === 'end') {
    return { ...execution, status: 'completed', activeNodeId: null }
  }

  if (currentNode.type === 'condition') {
    // For now, always take the 'then' branch — runtime engine will evaluate conditions
    const thenTargets = findNextNodes(activeNodeId, edges, 'then')
    const nextId = thenTargets[0]
    if (!nextId) {
      return { ...execution, status: 'error', error: `Condition node ${activeNodeId} has no 'then' target` }
    }

    const nextNode = nodes.find((n) => n.id === nextId)
    if (!nextNode) {
      return { ...execution, status: 'error', error: `Target node ${nextId} not found` }
    }

    const log: StepLog = {
      nodeId: nextId,
      nodeType: nextNode.type ?? 'unknown',
      label: String(nextNode.data.label ?? ''),
      prompt: String(nextNode.data.prompt ?? ''),
      state: { ...execution.state },
      timestamp: Date.now(),
    }

    return {
      ...execution,
      activeNodeId: nextId,
      visitedNodeIds: [...execution.visitedNodeIds, nextId],
      logs: [...execution.logs, log],
    }
  }

  // Default: follow the first outgoing edge
  const nextIds = findNextNodes(activeNodeId, edges)
  if (nextIds.length === 0) {
    return { ...execution, status: 'completed', activeNodeId: null }
  }

  const nextId = nextIds[0]
  const nextNode = nodes.find((n) => n.id === nextId)
  if (!nextNode) {
    return { ...execution, status: 'error', error: `Target node ${nextId} not found` }
  }

  const log: StepLog = {
    nodeId: nextId,
    nodeType: nextNode.type ?? 'unknown',
    label: String(nextNode.data.label ?? ''),
    prompt: String(nextNode.data.prompt ?? ''),
    state: { ...execution.state },
    timestamp: Date.now(),
  }

  // If the next node is an approval node, move to it and pause
  const nextStatus = nextNode.type === 'approval' ? 'paused' : execution.status

  return {
    ...execution,
    status: nextStatus,
    activeNodeId: nextId,
    visitedNodeIds: [...execution.visitedNodeIds, nextId],
    logs: [...execution.logs, log],
  }
}
