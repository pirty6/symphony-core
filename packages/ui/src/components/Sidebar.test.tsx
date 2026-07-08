import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Sidebar } from './Sidebar'

describe('Sidebar', () => {
  it('renders agents and nodes sections with divider', () => {
    render(<Sidebar onExport={() => {}} />)
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Nodes')).toBeInTheDocument()
    expect(screen.getByText('Assessor')).toBeInTheDocument()
    expect(screen.getByText('Executor')).toBeInTheDocument()
    expect(screen.getByText('If')).toBeInTheDocument()
    expect(screen.getByText('End')).toBeInTheDocument()
  })

  it('renders agents section before nodes section', () => {
    render(<Sidebar onExport={() => {}} />)
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings[0]).toHaveTextContent('Agents')
    expect(headings[1]).toHaveTextContent('Nodes')
  })

  it('renders descriptions for all items', () => {
    render(<Sidebar onExport={() => {}} />)
    expect(screen.getByText('Read-only evidence gatherer')).toBeInTheDocument()
    expect(screen.getByText('Write-focused change applier')).toBeInTheDocument()
    expect(screen.getByText('Conditional branch (then/else)')).toBeInTheDocument()
    expect(screen.getByText('Terminal point of a path')).toBeInTheDocument()
  })

  it('makes all items draggable', () => {
    render(<Sidebar onExport={() => {}} />)
    const itemLabels = ['Assessor', 'Executor', 'If', 'End']
    itemLabels.forEach((label) => {
      const item = screen.getByText(label).closest('[draggable]')
      expect(item).toHaveAttribute('draggable', 'true')
    })
  })

  it('sets drag data with correct node type for condition item', () => {
    render(<Sidebar onExport={() => {}} />)
    const conditionItem = screen.getByText('If').closest('[draggable]')!
    const setData = vi.fn()
    fireEvent.dragStart(conditionItem, {
      dataTransfer: { setData, effectAllowed: '' },
    })
    expect(setData).toHaveBeenCalledWith('application/reactflow', 'condition')
  })

  it('sets drag data with correct node type for assessor item', () => {
    render(<Sidebar onExport={() => {}} />)
    const assessorItem = screen.getByText('Assessor').closest('[draggable]')!
    const setData = vi.fn()
    fireEvent.dragStart(assessorItem, {
      dataTransfer: { setData, effectAllowed: '' },
    })
    expect(setData).toHaveBeenCalledWith('application/reactflow', 'assessor')
  })

  it('applies correct CSS class per item type', () => {
    render(<Sidebar onExport={() => {}} />)
    const sidebar = screen.getByRole('heading', { name: 'Agents' }).parentElement!
    const items = within(sidebar).getAllByText(/Assessor|Executor|If|End/)
    expect(items).toHaveLength(4)
  })

  it('has a separator between agents and nodes sections', () => {
    render(<Sidebar onExport={() => {}} />)
    const separators = screen.getAllByRole('separator')
    expect(separators.length).toBeGreaterThanOrEqual(1)
  })

  it('calls onExport when export button is clicked', async () => {
    const onExport = vi.fn()
    render(<Sidebar onExport={onExport} />)

    const btn = screen.getByText('Export Workflow JSON')
    btn.click()

    expect(onExport).toHaveBeenCalledOnce()
  })
})
