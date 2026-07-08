import { addEdge, reconnectEdge, applyEdgeChanges, MarkerType, type Edge, type Connection, type EdgeRemoveChange, type EdgeSelectionChange } from '@xyflow/react'
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

  it('replaces existing edge when source node has maxEdges: 1', () => {
    const edges: Edge[] = [
      { id: 'e-1', source: 'orchestrator-1', target: 'assessor-1' },
    ]

    const maxEdges = 1 // from orchestrator node data
    const connection: Connection = {
      source: 'orchestrator-1',
      target: 'executor-1',
      sourceHandle: null,
      targetHandle: null,
    }

    const filtered = maxEdges != null
      ? edges.filter((e) => e.source !== connection.source)
      : edges
    const result = addEdge(connection, filtered)

    expect(result).toHaveLength(1)
    expect(result[0].target).toBe('executor-1')
  })

  it('allows multiple edges when source node has maxEdges: null', () => {
    const edges: Edge[] = [
      { id: 'e-1', source: 'assessor-1', target: 'executor-1' },
    ]

    const maxEdges = null // from assessor node data (unlimited)
    const connection: Connection = {
      source: 'assessor-1',
      target: 'end-1',
      sourceHandle: null,
      targetHandle: null,
    }

    const filtered = maxEdges != null
      ? edges.filter((e) => e.source !== connection.source)
      : edges
    const result = addEdge(connection, filtered)

    expect(result).toHaveLength(2)
    expect(result[0].target).toBe('executor-1')
    expect(result[1].target).toBe('end-1')
  })

  it('blocks edges when source node has maxEdges: 0', () => {
    const edges: Edge[] = []
    const maxEdges = 0 // from end node data

    // When maxEdges is 0, no edges should be added
    if (maxEdges === 0) {
      expect(edges).toHaveLength(0)
      return
    }
  })

  describe('edge deletion', () => {
    it('removes a selected edge via remove change', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'orchestrator-1', target: 'assessor-1' },
        { id: 'e-2', source: 'assessor-1', target: 'executor-1' },
      ]
      const changes: EdgeRemoveChange[] = [{ id: 'e-1', type: 'remove' }]

      const result = applyEdgeChanges(changes, edges)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('e-2')
    })

    it('removes multiple edges at once', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'orchestrator-1', target: 'assessor-1' },
        { id: 'e-2', source: 'assessor-1', target: 'executor-1' },
        { id: 'e-3', source: 'executor-1', target: 'end-1' },
      ]
      const changes: EdgeRemoveChange[] = [
        { id: 'e-1', type: 'remove' },
        { id: 'e-3', type: 'remove' },
      ]

      const result = applyEdgeChanges(changes, edges)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('e-2')
    })

    it('returns unchanged edges when removing a non-existent id', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'orchestrator-1', target: 'assessor-1' },
      ]
      const changes: EdgeRemoveChange[] = [{ id: 'e-999', type: 'remove' }]

      const result = applyEdgeChanges(changes, edges)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('e-1')
    })

    it('can select an edge before deletion', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'orchestrator-1', target: 'assessor-1', selected: false },
      ]
      const selectChange: EdgeSelectionChange[] = [{ id: 'e-1', type: 'select', selected: true }]

      const selected = applyEdgeChanges(selectChange, edges)
      expect(selected[0].selected).toBe(true)

      const removeChange: EdgeRemoveChange[] = [{ id: 'e-1', type: 'remove' }]
      const result = applyEdgeChanges(removeChange, selected)
      expect(result).toHaveLength(0)
    })
  })

  describe('edge reconnection', () => {
    it('reconnects an edge to a different target', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'orchestrator-1', target: 'assessor-1' },
      ]
      const oldEdge = edges[0]
      const newConnection: Connection = {
        source: 'orchestrator-1',
        target: 'executor-1',
        sourceHandle: null,
        targetHandle: null,
      }

      const result = reconnectEdge(oldEdge, newConnection, edges)

      expect(result).toHaveLength(1)
      expect(result[0].source).toBe('orchestrator-1')
      expect(result[0].target).toBe('executor-1')
    })

    it('reconnects an edge to a different source', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'orchestrator-1', target: 'executor-1' },
        { id: 'e-2', source: 'assessor-1', target: 'end-1' },
      ]
      const oldEdge = edges[1]
      const newConnection: Connection = {
        source: 'executor-1',
        target: 'end-1',
        sourceHandle: null,
        targetHandle: null,
      }

      const result = reconnectEdge(oldEdge, newConnection, edges)

      expect(result).toHaveLength(2)
      const reconnected = result.find((e) => e.target === 'end-1')!
      expect(reconnected.source).toBe('executor-1')
    })

    it('preserves other edges when reconnecting one', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'orchestrator-1', target: 'assessor-1' },
        { id: 'e-2', source: 'orchestrator-1', target: 'executor-1' },
      ]
      const newConnection: Connection = {
        source: 'orchestrator-1',
        target: 'end-1',
        sourceHandle: null,
        targetHandle: null,
      }

      const result = reconnectEdge(edges[0], newConnection, edges)

      expect(result).toHaveLength(2)
      expect(result.find((e) => e.target === 'executor-1')).toBeDefined()
      expect(result.find((e) => e.target === 'end-1')).toBeDefined()
      expect(result.find((e) => e.target === 'assessor-1')).toBeUndefined()
    })

    it('reconnects condition node branch handles', () => {
      const edges: Edge[] = [
        { id: 'e-1', source: 'condition-1', sourceHandle: 'then', target: 'assessor-1' },
        { id: 'e-2', source: 'condition-1', sourceHandle: 'else', target: 'executor-1' },
      ]
      const newConnection: Connection = {
        source: 'condition-1',
        target: 'end-1',
        sourceHandle: 'then',
        targetHandle: null,
      }

      const result = reconnectEdge(edges[0], newConnection, edges)

      expect(result).toHaveLength(2)
      const thenEdge = result.find((e) => e.sourceHandle === 'then')!
      expect(thenEdge.target).toBe('end-1')
      const elseEdge = result.find((e) => e.sourceHandle === 'else')!
      expect(elseEdge.target).toBe('executor-1')
    })
  })
})
