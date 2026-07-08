import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { ExecutorNode } from './ExecutorNode'

function renderNode(prompt?: string) {
  return render(
    <ReactFlowProvider>
      <ExecutorNode
        id="executor-1"
        type="executor"
        data={{ label: 'Executor', description: 'Write-focused change applier', prompt }}
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

describe('ExecutorNode', () => {
  it('renders label and description', () => {
    renderNode()
    expect(screen.getByText('Executor')).toBeInTheDocument()
    expect(screen.getByText('Write-focused change applier')).toBeInTheDocument()
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
    renderNode('Apply the security patch')
    expect(screen.getByTestId('node-prompt')).toHaveValue('Apply the security patch')
  })

  it('shows placeholder when prompt is empty', () => {
    renderNode()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toHaveAttribute('placeholder', 'What should this executor do?')
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
