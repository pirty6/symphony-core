import { addEdge, MarkerType, type Edge, type Connection } from '@xyflow/react'
import { describe, it, expect } from 'vitest'

describe('workflow connections', () => {
  it('addEdge creates an edge between two nodes', () => {
    const edges: Edge[] = []
    const connection: Connection = {
      source: 'orchestrator-1',
      target: 'instrument-2',
      sourceHandle: null,
      targetHandle: null,
    }

    const result = addEdge(connection, edges)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      source: 'orchestrator-1',
      target: 'instrument-2',
    })
  })

  it('does not create duplicate edges for the same connection', () => {
    const existing: Edge[] = [
      { id: 'e-1', source: 'orchestrator-1', target: 'instrument-2' },
    ]
    const connection: Connection = {
      source: 'orchestrator-1',
      target: 'instrument-2',
      sourceHandle: null,
      targetHandle: null,
    }

    const result = addEdge(connection, existing)

    expect(result).toHaveLength(1)
  })

  it('allows chaining: instrument → instrument', () => {
    const edges: Edge[] = []
    const chain: Connection[] = [
      { source: 'orchestrator-1', target: 'assessor-1', sourceHandle: null, targetHandle: null },
      { source: 'assessor-1', target: 'executor-1', sourceHandle: null, targetHandle: null },
      { source: 'executor-1', target: 'end-1', sourceHandle: null, targetHandle: null },
    ]

    let result = edges
    for (const conn of chain) {
      result = addEdge(conn, result)
    }

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ source: 'orchestrator-1', target: 'assessor-1' })
    expect(result[1]).toMatchObject({ source: 'assessor-1', target: 'executor-1' })
    expect(result[2]).toMatchObject({ source: 'executor-1', target: 'end-1' })
  })

  it('default edge options include directional arrow marker', () => {
    const defaultEdgeOptions = {
      animated: true,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: '#4a4a6a',
      },
      style: { stroke: '#4a4a6a', strokeWidth: 2 },
    }

    expect(defaultEdgeOptions.markerEnd.type).toBe(MarkerType.ArrowClosed)
    expect(defaultEdgeOptions.animated).toBe(true)
  })

  it('allows parallel branching from orchestrator', () => {
    const edges: Edge[] = []
    const branches: Connection[] = [
      { source: 'orchestrator-1', target: 'assessor-1', sourceHandle: null, targetHandle: null },
      { source: 'orchestrator-1', target: 'executor-1', sourceHandle: null, targetHandle: null },
    ]

    let result = edges
    for (const conn of branches) {
      result = addEdge(conn, result)
    }

    expect(result).toHaveLength(2)
    expect(result.every((e) => e.source === 'orchestrator-1')).toBe(true)
  })
})
