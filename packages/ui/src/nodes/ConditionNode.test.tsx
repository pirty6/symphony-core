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

  it('has the condition class', () => {
    renderNode()
    const node = screen.getByText('If').closest('.workflow-node')
    expect(node).toHaveClass('condition')
  })

  it('has one target handle and two source handles (then/else)', () => {
    const { container } = renderNode()
    const targetHandles = container.querySelectorAll('.react-flow__handle-top')
    const sourceHandles = container.querySelectorAll('.react-flow__handle-bottom')
    expect(targetHandles).toHaveLength(1)
    expect(sourceHandles).toHaveLength(2)
  })
})
