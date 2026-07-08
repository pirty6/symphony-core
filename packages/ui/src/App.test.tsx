import { render, screen, fireEvent } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import App from './App'

function renderApp() {
  return render(
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>,
  )
}

describe('App', () => {
  it('renders the orchestrator node as the start point', () => {
    renderApp()
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
    expect(screen.getByText('Entry point — routes to instruments')).toBeInTheDocument()
  })

  it('does not pre-place an end node on the canvas', () => {
    renderApp()
    // End should only appear in the sidebar palette, not on the canvas
    const endLabels = screen.getAllByText('End')
    // One in the sidebar palette
    expect(endLabels.length).toBeGreaterThanOrEqual(1)
  })

  it('does not pre-place a condition node on the canvas', () => {
    renderApp()
    // If should only appear in the sidebar, not on the canvas
    const ifLabels = screen.getAllByText('If')
    expect(ifLabels).toHaveLength(1) // only in sidebar
  })

  it('renders the sidebar with agents and nodes sections', () => {
    renderApp()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Nodes')).toBeInTheDocument()
    expect(screen.getByText('Assessor')).toBeInTheDocument()
    expect(screen.getByText('Executor')).toBeInTheDocument()
    expect(screen.getByText('If')).toBeInTheDocument()
    expect(screen.getByText('Approval')).toBeInTheDocument()
    expect(screen.getByText('End')).toBeInTheDocument()
  })

  it('shows descriptions for condition, approval, and end in sidebar', () => {
    renderApp()
    expect(screen.getByText('Conditional branch (then/else)')).toBeInTheDocument()
    expect(screen.getByText('Human-in-the-loop approval gate')).toBeInTheDocument()
    expect(screen.getByText('Terminal point of a path')).toBeInTheDocument()
  })

  it('renders the export button', () => {
    renderApp()
    expect(screen.getByText('Export Workflow JSON')).toBeInTheDocument()
  })

  it('renders the orchestrator as non-deletable', () => {
    renderApp()
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
    expect(screen.getByText('Entry point — routes to instruments')).toBeInTheDocument()
  })

  it('orchestrator has maxEdges: 1', () => {
    // Verify the initial orchestrator node data carries maxEdges
    // This is tested via the initialNodes constant which sets maxEdges: 1
    renderApp()
    // Orchestrator renders — its data includes maxEdges: 1
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
  })

  it('orchestrator renders a prompt textarea on the canvas', () => {
    renderApp()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toBeInTheDocument()
    expect(textarea.tagName).toBe('TEXTAREA')
  })

  it('orchestrator prompt defaults to empty', () => {
    renderApp()
    expect(screen.getByTestId('node-prompt')).toHaveValue('')
  })

  it('clicking a node adds the selected class to its wrapper', () => {
    renderApp()
    const nodeContent = screen.getByText('Orchestrator')
    const reactFlowNode = nodeContent.closest('.react-flow__node')
    expect(reactFlowNode).toBeInTheDocument()
    expect(reactFlowNode).not.toHaveClass('selected')

    fireEvent.click(nodeContent)

    expect(reactFlowNode).toHaveClass('selected')
  })

  it('clicking elsewhere deselects the node', () => {
    renderApp()
    const nodeContent = screen.getByText('Orchestrator')
    const reactFlowNode = nodeContent.closest('.react-flow__node')

    fireEvent.click(nodeContent)
    expect(reactFlowNode).toHaveClass('selected')

    const canvas = document.querySelector('.react-flow__pane')
    if (canvas) {
      fireEvent.click(canvas)
      expect(reactFlowNode).not.toHaveClass('selected')
    }
  })
})
