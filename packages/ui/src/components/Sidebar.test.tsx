import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { createInitialExecutionState, type ExecutionState } from '../runtime'

describe('Sidebar', () => {
  const noop = () => {}
  const noopRun = (_debug: boolean) => {}

  it('renders agents and nodes sections with divider', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Nodes')).toBeInTheDocument()
    expect(screen.getByText('Assessor')).toBeInTheDocument()
    expect(screen.getByText('Executor')).toBeInTheDocument()
    expect(screen.getByText('If')).toBeInTheDocument()
    expect(screen.getByText('Approval')).toBeInTheDocument()
    expect(screen.getByText('End')).toBeInTheDocument()
  })

  it('renders agents section before nodes section', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings[0]).toHaveTextContent('Agents')
    expect(headings[1]).toHaveTextContent('Nodes')
  })

  it('renders descriptions for all items', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    expect(screen.getByText('Read-only evidence gatherer')).toBeInTheDocument()
    expect(screen.getByText('Write-focused change applier')).toBeInTheDocument()
    expect(screen.getByText('Conditional branch (then/else)')).toBeInTheDocument()
    expect(screen.getByText('Human-in-the-loop approval gate')).toBeInTheDocument()
    expect(screen.getByText('Terminal point of a path')).toBeInTheDocument()
  })

  it('makes all items draggable', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    const itemLabels = ['Assessor', 'Executor', 'If', 'Approval', 'End']
    itemLabels.forEach((label) => {
      const item = screen.getByText(label).closest('[draggable]')
      expect(item).toHaveAttribute('draggable', 'true')
    })
  })

  it('sets drag data with correct node type for condition item', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    const conditionItem = screen.getByText('If').closest('[draggable]')!
    const setData = vi.fn()
    fireEvent.dragStart(conditionItem, {
      dataTransfer: { setData, effectAllowed: '' },
    })
    expect(setData).toHaveBeenCalledWith('application/reactflow', 'condition')
  })

  it('sets drag data with correct node type for assessor item', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    const assessorItem = screen.getByText('Assessor').closest('[draggable]')!
    const setData = vi.fn()
    fireEvent.dragStart(assessorItem, {
      dataTransfer: { setData, effectAllowed: '' },
    })
    expect(setData).toHaveBeenCalledWith('application/reactflow', 'assessor')
  })

  it('applies correct CSS class per item type', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    const sidebar = screen.getByRole('heading', { name: 'Agents' }).parentElement!
    const items = within(sidebar).getAllByText(/Assessor|Executor|If|Approval|End/)
    expect(items).toHaveLength(5)
  })

  it('has a separator between agents and nodes sections', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    const separators = screen.getAllByRole('separator')
    expect(separators.length).toBeGreaterThanOrEqual(1)
  })

  it('calls onExport when export button is clicked', async () => {
    const onExport = vi.fn()
    render(<Sidebar onExport={onExport} onRun={noopRun} />)

    const btn = screen.getByText('Export Workflow JSON')
    btn.click()

    expect(onExport).toHaveBeenCalledOnce()
  })

  it('renders run and debug buttons', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    expect(screen.getByTestId('btn-run')).toBeInTheDocument()
    expect(screen.getByTestId('btn-run')).toHaveTextContent('Run Workflow')
    expect(screen.getByTestId('btn-debug')).toBeInTheDocument()
  })

  it('calls onRun with false when run button is clicked', () => {
    const onRun = vi.fn()
    render(<Sidebar onExport={noop} onRun={onRun} />)

    screen.getByTestId('btn-run').click()

    expect(onRun).toHaveBeenCalledWith(false)
  })

  it('calls onRun with true when debug button is clicked', () => {
    const onRun = vi.fn()
    render(<Sidebar onExport={noop} onRun={onRun} />)

    screen.getByTestId('btn-debug').click()

    expect(onRun).toHaveBeenCalledWith(true)
  })

  it('debug button appears before run button', () => {
    render(<Sidebar onExport={noop} onRun={noopRun} />)
    const actions = screen.getByTestId('btn-run').closest('.sidebar-actions') as HTMLElement
    const buttons = within(actions).getAllByRole('button')
    expect(buttons[0]).toBe(screen.getByTestId('btn-debug'))
    expect(buttons[1]).toHaveTextContent('Run Workflow')
    expect(buttons[2]).toHaveTextContent('Export Workflow JSON')
  })

  it('shows step and stop buttons when running in debug mode', () => {
    const execution: ExecutionState = {
      ...createInitialExecutionState(true),
      status: 'running',
      activeNodeId: 'node-1',
    }
    render(
      <Sidebar
        onExport={noop}
        onRun={noopRun}
        onStep={noop}
        onStop={noop}
        execution={execution}
      />,
    )
    expect(screen.getByTestId('btn-step')).toBeInTheDocument()
    expect(screen.getByTestId('btn-stop')).toBeInTheDocument()
    expect(screen.queryByTestId('btn-run')).not.toBeInTheDocument()
  })

  it('hides step button when running in non-debug mode', () => {
    const execution: ExecutionState = {
      ...createInitialExecutionState(false),
      status: 'running',
      activeNodeId: 'node-1',
    }
    render(
      <Sidebar
        onExport={noop}
        onRun={noopRun}
        onStep={noop}
        onStop={noop}
        execution={execution}
      />,
    )
    expect(screen.queryByTestId('btn-step')).not.toBeInTheDocument()
    expect(screen.getByTestId('btn-stop')).toBeInTheDocument()
  })

  it('shows resume button when paused', () => {
    const execution: ExecutionState = {
      ...createInitialExecutionState(false),
      status: 'paused',
      activeNodeId: 'approval-1',
    }
    render(
      <Sidebar
        onExport={noop}
        onRun={noopRun}
        onResume={noop}
        onStop={noop}
        execution={execution}
      />,
    )
    expect(screen.getByTestId('btn-resume')).toBeInTheDocument()
    expect(screen.getByTestId('btn-stop')).toBeInTheDocument()
    expect(screen.queryByTestId('btn-run')).not.toBeInTheDocument()
  })

  it('shows run and debug buttons when idle', () => {
    const execution = createInitialExecutionState(false)
    render(
      <Sidebar
        onExport={noop}
        onRun={noopRun}
        onStop={noop}
        execution={execution}
      />,
    )
    expect(screen.getByTestId('btn-run')).toBeInTheDocument()
    expect(screen.getByTestId('btn-debug')).toBeInTheDocument()
    expect(screen.queryByTestId('btn-stop')).not.toBeInTheDocument()
  })
})
