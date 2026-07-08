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
