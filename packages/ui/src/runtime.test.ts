import { describe, it, expect } from 'vitest'
import {
  createInitialExecutionState,
  buildInitialState,
  findNextNodes,
  findOrchestratorNode,
  walkStep,
} from './runtime'
import type { StateField } from './types'

describe('createInitialExecutionState', () => {
  it('returns idle state with debug flag', () => {
    const state = createInitialExecutionState(true)
    expect(state.status).toBe('idle')
    expect(state.activeNodeId).toBeNull()
    expect(state.visitedNodeIds).toEqual([])
    expect(state.logs).toEqual([])
    expect(state.debug).toBe(true)
  })

  it('respects debug false', () => {
    const state = createInitialExecutionState(false)
    expect(state.debug).toBe(false)
  })
})

describe('buildInitialState', () => {
  it('creates defaults for each type', () => {
    const fields: StateField[] = [
      { name: 'word', type: 'string' },
      { name: 'score', type: 'number' },
      { name: 'active', type: 'boolean' },
      { name: 'letters', type: 'string[]' },
      { name: 'counts', type: 'number[]' },
      { name: 'meta', type: 'object' },
    ]
    const state = buildInitialState(fields)
    expect(state).toEqual({
      word: '',
      score: 0,
      active: false,
      letters: [],
      counts: [],
      meta: {},
    })
  })

  it('returns empty object for no fields', () => {
    expect(buildInitialState([])).toEqual({})
  })
})

describe('findNextNodes', () => {
  const edges = [
    { id: 'e1', source: 'a', target: 'b', sourceHandle: null },
    { id: 'e2', source: 'a', target: 'c', sourceHandle: 'then' },
    { id: 'e3', source: 'a', target: 'd', sourceHandle: 'else' },
    { id: 'e4', source: 'b', target: 'e', sourceHandle: null },
  ]

  it('finds all targets from a source', () => {
    const targets = findNextNodes('a', edges)
    expect(targets).toEqual(['b', 'c', 'd'])
  })

  it('filters by sourceHandle', () => {
    expect(findNextNodes('a', edges, 'then')).toEqual(['c'])
    expect(findNextNodes('a', edges, 'else')).toEqual(['d'])
  })

  it('returns empty for no matches', () => {
    expect(findNextNodes('z', edges)).toEqual([])
  })
})

describe('findOrchestratorNode', () => {
  it('finds the orchestrator', () => {
    const nodes = [
      { id: '1', type: 'orchestrator', data: { label: 'Orch' } },
      { id: '2', type: 'assessor', data: { label: 'Assess' } },
    ]
    expect(findOrchestratorNode(nodes)?.id).toBe('1')
  })

  it('returns undefined if no orchestrator', () => {
    const nodes = [{ id: '2', type: 'assessor', data: { label: 'Assess' } }]
    expect(findOrchestratorNode(nodes)).toBeUndefined()
  })
})

describe('walkStep', () => {
  const nodes = [
    { id: 'orch', type: 'orchestrator', data: { label: 'Orchestrator', prompt: 'Main', stateFields: [{ name: 'x', type: 'string' }] } },
    { id: 'assess', type: 'assessor', data: { label: 'Assessor', prompt: 'Investigate' } },
    { id: 'approval', type: 'approval', data: { label: 'Approval', prompt: '' } },
    { id: 'end', type: 'end', data: { label: 'End' } },
  ]
  const edges = [
    { id: 'e1', source: 'orch', target: 'assess', sourceHandle: null },
    { id: 'e2', source: 'assess', target: 'approval', sourceHandle: null },
    { id: 'e3', source: 'approval', target: 'end', sourceHandle: null },
  ]

  it('first step activates the orchestrator', () => {
    const initial = createInitialExecutionState(true)
    const next = walkStep(initial, nodes, edges)
    expect(next.status).toBe('running')
    expect(next.activeNodeId).toBe('orch')
    expect(next.visitedNodeIds).toEqual(['orch'])
    expect(next.state).toEqual({ x: '' })
    expect(next.logs).toHaveLength(1)
  })

  it('second step moves to assessor', () => {
    let state = createInitialExecutionState(true)
    state = walkStep(state, nodes, edges) // → orch
    state = walkStep(state, nodes, edges) // → assess
    expect(state.activeNodeId).toBe('assess')
    expect(state.visitedNodeIds).toEqual(['orch', 'assess'])
  })

  it('pauses at approval node', () => {
    let state = createInitialExecutionState(true)
    state = walkStep(state, nodes, edges) // → orch
    state = walkStep(state, nodes, edges) // → assess
    state = walkStep(state, nodes, edges) // → approval (pauses on arrival)
    expect(state.activeNodeId).toBe('approval')
    expect(state.status).toBe('paused')
  })

  it('completes at end node', () => {
    let state = createInitialExecutionState(true)
    state = walkStep(state, nodes, edges) // → orch
    state = walkStep(state, nodes, edges) // → assess
    state = walkStep(state, nodes, edges) // → approval (paused)
    expect(state.status).toBe('paused')
    state = { ...state, status: 'running' }
    state = walkStep(state, nodes, edges) // → end
    expect(state.activeNodeId).toBe('end')
    state = walkStep(state, nodes, edges) // completed
    expect(state.status).toBe('completed')
    expect(state.activeNodeId).toBeNull()
  })

  it('errors if no orchestrator', () => {
    const initial = createInitialExecutionState(true)
    const result = walkStep(initial, [], edges)
    expect(result.status).toBe('error')
    expect(result.error).toBe('No orchestrator node found')
  })

  it('completes if node has no outgoing edges', () => {
    const isolated = [
      { id: 'orch', type: 'orchestrator', data: { label: 'Orch', prompt: '' } },
    ]
    let state = createInitialExecutionState(true)
    state = walkStep(state, isolated, []) // → orch
    state = walkStep(state, isolated, []) // no edges → completed
    expect(state.status).toBe('completed')
  })

  it('handles condition node (takes then branch)', () => {
    const condNodes = [
      { id: 'orch', type: 'orchestrator', data: { label: 'Orch', prompt: '' } },
      { id: 'cond', type: 'condition', data: { label: 'If', prompt: 'check' } },
      { id: 'yes', type: 'executor', data: { label: 'Yes', prompt: '' } },
      { id: 'no', type: 'executor', data: { label: 'No', prompt: '' } },
    ]
    const condEdges = [
      { id: 'e1', source: 'orch', target: 'cond', sourceHandle: null },
      { id: 'e2', source: 'cond', target: 'yes', sourceHandle: 'then' },
      { id: 'e3', source: 'cond', target: 'no', sourceHandle: 'else' },
    ]
    let state = createInitialExecutionState(true)
    state = walkStep(state, condNodes, condEdges) // → orch
    state = walkStep(state, condNodes, condEdges) // → cond
    state = walkStep(state, condNodes, condEdges) // → yes (then branch)
    expect(state.activeNodeId).toBe('yes')
  })

  it('logs include prompt and node type', () => {
    let state = createInitialExecutionState(true)
    state = walkStep(state, nodes, edges) // → orch
    state = walkStep(state, nodes, edges) // → assess
    const assessLog = state.logs[1]
    expect(assessLog.label).toBe('Assessor')
    expect(assessLog.nodeType).toBe('assessor')
    expect(assessLog.prompt).toBe('Investigate')
  })
})
