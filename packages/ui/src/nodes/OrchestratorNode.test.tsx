import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { OrchestratorNode } from './OrchestratorNode'

function renderNode(prompt?: string) {
  return render(
    <ReactFlowProvider>
      <OrchestratorNode
        id="orchestrator-1"
        type="orchestrator"
        data={{ label: 'Orchestrator', description: 'Entry point', prompt }}
        dragging={false}
        draggable={true}
        selectable={true}
        deletable={true}
        selected={false}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        zIndex={0}
      />
    </ReactFlowProvider>,
  )
}

describe('OrchestratorNode', () => {
  it('renders label and description', () => {
    renderNode()
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
    expect(screen.getByText('Entry point')).toBeInTheDocument()
  })

  it('has the orchestrator class', () => {
    renderNode()
    const node = screen.getByText('Orchestrator').closest('.workflow-node')
    expect(node).toHaveClass('orchestrator')
  })

  it('has only a source handle (no target — it is the start)', () => {
    renderNode()
    expect(screen.getByTestId('handle-source')).toBeInTheDocument()
    expect(screen.queryByTestId('handle-target')).not.toBeInTheDocument()
  })

  it('renders a prompt textarea', () => {
    renderNode()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toBeInTheDocument()
    expect(textarea.tagName).toBe('TEXTAREA')
  })

  it('displays the prompt value', () => {
    renderNode('Investigate auth module')
    expect(screen.getByTestId('node-prompt')).toHaveValue('Investigate auth module')
  })

  it('shows placeholder when prompt is empty', () => {
    renderNode()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toHaveAttribute('placeholder', 'Main prompt — what should this workflow accomplish?')
  })

  it('defaults to empty string when prompt is undefined', () => {
    renderNode()
    expect(screen.getByTestId('node-prompt')).toHaveValue('')
  })

  it('textarea has the node-prompt class', () => {
    renderNode()
    expect(screen.getByTestId('node-prompt')).toHaveClass('node-prompt')
  })
})
