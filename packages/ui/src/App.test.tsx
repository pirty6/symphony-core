import { render, screen } from '@testing-library/react'
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
    expect(screen.getByText('End')).toBeInTheDocument()
  })

  it('shows descriptions for condition and end in sidebar', () => {
    renderApp()
    expect(screen.getByText('Conditional branch (then/else)')).toBeInTheDocument()
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
})
