import { describe, it, expect } from 'vitest'
import { AGENT_ITEMS, CONTROL_ITEMS } from './types'
import type { PaletteItem, DraggableNodeType } from './types'

describe('AGENT_ITEMS', () => {
  it('contains assessor and executor', () => {
    const types = AGENT_ITEMS.map((i) => i.type)
    expect(types).toEqual(['assessor', 'executor'])
  })

  it('each item has required fields', () => {
    AGENT_ITEMS.forEach((item: PaletteItem) => {
      expect(item.type).toBeTruthy()
      expect(item.label).toBeTruthy()
      expect(item.description).toBeTruthy()
      expect(item.icon).toBeTruthy()
    })
  })
})

describe('CONTROL_ITEMS', () => {
  it('contains condition and end', () => {
    const types = CONTROL_ITEMS.map((i) => i.type)
    expect(types).toEqual(['condition', 'end'])
  })

  it('each item has required fields', () => {
    CONTROL_ITEMS.forEach((item: PaletteItem) => {
      expect(item.type).toBeTruthy()
      expect(item.label).toBeTruthy()
      expect(item.description).toBeTruthy()
      expect(item.icon).toBeTruthy()
    })
  })
})

describe('DraggableNodeType', () => {
  it('all palette items have valid DraggableNodeType values', () => {
    const validTypes: DraggableNodeType[] = ['assessor', 'executor', 'end', 'condition']
    const allItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]
    allItems.forEach((item) => {
      expect(validTypes).toContain(item.type)
    })
  })
})

describe('maxEdges on palette items', () => {
  it('assessor allows 1 outgoing edge', () => {
    const assessor = AGENT_ITEMS.find((i) => i.type === 'assessor')!
    expect(assessor.maxEdges).toBe(1)
  })

  it('executor allows 1 outgoing edge', () => {
    const executor = AGENT_ITEMS.find((i) => i.type === 'executor')!
    expect(executor.maxEdges).toBe(1)
  })

  it('condition allows 1 outgoing edge', () => {
    const condition = CONTROL_ITEMS.find((i) => i.type === 'condition')!
    expect(condition.maxEdges).toBe(1)
  })

  it('end node allows 0 outgoing edges', () => {
    const end = CONTROL_ITEMS.find((i) => i.type === 'end')!
    expect(end.maxEdges).toBe(0)
  })

  it('end is the only node type with maxEdges: 0', () => {
    const allItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]
    const zeroEdgeItems = allItems.filter((i) => i.maxEdges === 0)
    expect(zeroEdgeItems).toHaveLength(1)
    expect(zeroEdgeItems[0].type).toBe('end')
  })

  it('all non-end nodes allow exactly 1 outgoing edge', () => {
    const allItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]
    const nonEnd = allItems.filter((i) => i.type !== 'end')
    nonEnd.forEach((item) => {
      expect(item.maxEdges).toBe(1)
    })
  })

  it('every palette item has a valid maxEdges (0 or 1)', () => {
    const allItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]
    allItems.forEach((item) => {
      expect([0, 1]).toContain(item.maxEdges)
    })
  })
})
