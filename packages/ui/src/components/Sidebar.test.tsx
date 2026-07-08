import { render, screen, fireEvent } from '@testing-library/react'
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
    const { container } = render(<Sidebar onExport={() => {}} />)
    const headings = container.querySelectorAll('h2')
    expect(headings[0].textContent).toBe('Agents')
    expect(headings[1].textContent).toBe('Nodes')
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
    const items = document.querySelectorAll('.sidebar-item')
    expect(items).toHaveLength(4)
    items.forEach((item) => {
      expect(item).toHaveAttribute('draggable', 'true')
    })
  })

  it('sets drag data with correct node type for condition item', () => {
    render(<Sidebar onExport={() => {}} />)
    const conditionItem = screen.getByText('If').closest('.sidebar-item')!
    const setData = vi.fn()
    fireEvent.dragStart(conditionItem, {
      dataTransfer: { setData, effectAllowed: '' },
    })
    expect(setData).toHaveBeenCalledWith('application/reactflow', 'condition')
  })

  it('sets drag data with correct node type for assessor item', () => {
    render(<Sidebar onExport={() => {}} />)
    const assessorItem = screen.getByText('Assessor').closest('.sidebar-item')!
    const setData = vi.fn()
    fireEvent.dragStart(assessorItem, {
      dataTransfer: { setData, effectAllowed: '' },
    })
    expect(setData).toHaveBeenCalledWith('application/reactflow', 'assessor')
  })

  it('applies correct CSS class per item type', () => {
    render(<Sidebar onExport={() => {}} />)
    expect(screen.getByText('If').closest('.sidebar-item')).toHaveClass('condition')
    expect(screen.getByText('End').closest('.sidebar-item')).toHaveClass('end')
    expect(screen.getByText('Assessor').closest('.sidebar-item')).toHaveClass('assessor')
    expect(screen.getByText('Executor').closest('.sidebar-item')).toHaveClass('executor')
  })

  it('has a separator between agents and nodes sections', () => {
    const { container } = render(<Sidebar onExport={() => {}} />)
    const separators = container.querySelectorAll('.sidebar-separator')
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
