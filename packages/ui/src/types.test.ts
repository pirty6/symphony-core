import { describe, it, expect } from 'vitest'
import { AGENT_ITEMS, CONTROL_ITEMS, isDraggableNodeType } from './types'
import type { PaletteItem, DraggableNodeType, WorkflowNode } from './types'

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
  it('contains condition, approval, and end', () => {
    const types = CONTROL_ITEMS.map((i) => i.type)
    expect(types).toEqual(['condition', 'approval', 'end'])
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
    const validTypes: DraggableNodeType[] = ['assessor', 'executor', 'end', 'condition', 'approval']
    const allItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]
    allItems.forEach((item) => {
      expect(validTypes).toContain(item.type)
    })
  })
})

describe('maxEdges on palette items', () => {
  it('assessor allows unlimited outgoing edges', () => {
    const assessor = AGENT_ITEMS.find((i) => i.type === 'assessor')!
    expect(assessor.maxEdges).toBeNull()
  })

  it('executor allows unlimited outgoing edges', () => {
    const executor = AGENT_ITEMS.find((i) => i.type === 'executor')!
    expect(executor.maxEdges).toBeNull()
  })

  it('condition allows unlimited outgoing edges', () => {
    const condition = CONTROL_ITEMS.find((i) => i.type === 'condition')!
    expect(condition.maxEdges).toBeNull()
  })

  it('approval allows unlimited outgoing edges', () => {
    const approval = CONTROL_ITEMS.find((i) => i.type === 'approval')!
    expect(approval.maxEdges).toBeNull()
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

  it('all non-end nodes allow unlimited outgoing edges (null)', () => {
    const allItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]
    const nonEnd = allItems.filter((i) => i.type !== 'end')
    nonEnd.forEach((item) => {
      expect(item.maxEdges).toBeNull()
    })
  })

  it('every palette item has a valid maxEdges (0, 1, or null)', () => {
    const allItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]
    allItems.forEach((item) => {
      expect([0, 1, null]).toContain(item.maxEdges)
    })
  })
})

describe('WorkflowNode', () => {
  it('accepts a prompt field', () => {
    const node: WorkflowNode = {
      id: 'test-1',
      type: 'assessor',
      label: 'Assessor',
      prompt: 'Investigate the auth module',
    }
    expect(node.prompt).toBe('Investigate the auth module')
  })

  it('prompt is optional', () => {
    const node: WorkflowNode = {
      id: 'test-2',
      type: 'executor',
      label: 'Executor',
    }
    expect(node.prompt).toBeUndefined()
  })

  it('orchestrator node accepts a prompt', () => {
    const node: WorkflowNode = {
      id: 'orch-1',
      type: 'orchestrator',
      label: 'Orchestrator',
      prompt: 'Build a hangman game',
    }
    expect(node.prompt).toBe('Build a hangman game')
  })
})

describe('isDraggableNodeType', () => {
  it('returns true for all draggable types', () => {
    expect(isDraggableNodeType('assessor')).toBe(true)
    expect(isDraggableNodeType('executor')).toBe(true)
    expect(isDraggableNodeType('end')).toBe(true)
    expect(isDraggableNodeType('condition')).toBe(true)
    expect(isDraggableNodeType('approval')).toBe(true)
  })

  it('returns false for orchestrator (not draggable)', () => {
    expect(isDraggableNodeType('orchestrator')).toBe(false)
  })

  it('returns false for arbitrary strings', () => {
    expect(isDraggableNodeType('random')).toBe(false)
    expect(isDraggableNodeType('')).toBe(false)
  })
})
