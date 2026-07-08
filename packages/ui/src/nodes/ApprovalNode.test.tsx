import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { ApprovalNode } from './ApprovalNode'

function renderNode() {
  return render(
    <ReactFlowProvider>
      <ApprovalNode
        id="approval-1"
        type="approval"
        data={{ label: 'Approval', description: 'Human-in-the-loop approval gate' }}
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

describe('ApprovalNode', () => {
  it('renders label and description', () => {
    renderNode()
    expect(screen.getByText('Approval')).toBeInTheDocument()
    expect(screen.getByText('Human-in-the-loop approval gate')).toBeInTheDocument()
  })

  it('renders the hand icon', () => {
    renderNode()
    expect(screen.getByText('✋')).toBeInTheDocument()
  })

  it('has the approval class', () => {
    renderNode()
    const node = screen.getByText('Approval').closest('.workflow-node')
    expect(node).toHaveClass('approval')
  })

  it('has both target and source handles', () => {
    renderNode()
    expect(screen.getByTestId('handle-target')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source')).toBeInTheDocument()
  })
})
