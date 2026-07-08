import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { AssessorNode } from './AssessorNode'

function renderNode(prompt?: string) {
  return render(
    <ReactFlowProvider>
      <AssessorNode
        id="assessor-1"
        type="assessor"
        data={{ label: 'Assessor', description: 'Read-only evidence gatherer', prompt }}
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

describe('AssessorNode', () => {
  it('renders label and description', () => {
    renderNode()
    expect(screen.getByText('Assessor')).toBeInTheDocument()
    expect(screen.getByText('Read-only evidence gatherer')).toBeInTheDocument()
  })

  it('has both target and source handles (can be chained)', () => {
    renderNode()
    expect(screen.getByTestId('handle-target')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source')).toBeInTheDocument()
  })

  it('renders a prompt textarea', () => {
    renderNode()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toBeInTheDocument()
    expect(textarea.tagName).toBe('TEXTAREA')
  })

  it('displays the prompt value', () => {
    renderNode('Check for vulnerabilities')
    expect(screen.getByTestId('node-prompt')).toHaveValue('Check for vulnerabilities')
  })

  it('shows placeholder when prompt is empty', () => {
    renderNode()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toHaveAttribute('placeholder', 'What should this assessor investigate?')
  })

  it('defaults to empty string when prompt is undefined', () => {
    renderNode()
    expect(screen.getByTestId('node-prompt')).toHaveValue('')
  })

  it('textarea has the node-prompt class', () => {
    renderNode()
    expect(screen.getByTestId('node-prompt')).toHaveClass('node-prompt')
  })

  it('workflow-node is inside a selected wrapper when selected', () => {
    render(
      <ReactFlowProvider>
        <AssessorNode
          id="assessor-1"
          type="assessor"
          data={{ label: 'Assessor', description: 'Read-only evidence gatherer' }}
          dragging={false}
          draggable={true}
          selectable={true}
          deletable={true}
          selected={true}
          isConnectable={true}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          zIndex={0}
        />
      </ReactFlowProvider>,
    )
    const node = screen.getByText('Assessor').closest('.workflow-node')
    expect(node).toBeInTheDocument()
    expect(node).toHaveClass('workflow-node', 'assessor')
  })
})
