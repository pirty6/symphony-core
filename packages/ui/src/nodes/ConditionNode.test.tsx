import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { ConditionNode } from './ConditionNode'

function renderNode() {
  return render(
    <ReactFlowProvider>
      <ConditionNode
        id="condition-1"
        type="condition"
        data={{ label: 'If', description: 'Conditional branch (then/else)' }}
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

describe('ConditionNode', () => {
  it('renders label and description', () => {
    renderNode()
    expect(screen.getByText('If')).toBeInTheDocument()
    expect(screen.getByText('Conditional branch (then/else)')).toBeInTheDocument()
  })

  it('renders the diamond icon', () => {
    renderNode()
    expect(screen.getByText('◆')).toBeInTheDocument()
  })

  it('has the condition class', () => {
    renderNode()
    const node = screen.getByText('If').closest('.workflow-node')
    expect(node).toHaveClass('condition')
  })

  it('has one target handle and two source handles (then/else)', () => {
    renderNode()
    expect(screen.getByTestId('handle-target')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source-then')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source-else')).toBeInTheDocument()
  })

  it('source handles have distinct IDs for then and else', () => {
    renderNode()
    const thenHandle = screen.getByTestId('handle-source-then')
    const elseHandle = screen.getByTestId('handle-source-else')
    expect(thenHandle).not.toBe(elseHandle)
  })

  it('has node-header and node-subtitle structure', () => {
    renderNode()
    expect(screen.getByText('If')).toBeInTheDocument()
    expect(screen.getByText('◆')).toBeInTheDocument()
    expect(screen.getByText('Conditional branch (then/else)')).toBeInTheDocument()
  })
})
