import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { ExecutorNode } from './ExecutorNode'

function renderNode() {
  return render(
    <ReactFlowProvider>
      <ExecutorNode
        id="executor-1"
        type="executor"
        data={{ label: 'Executor', description: 'Write-focused change applier' }}
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
    const { container } = renderNode()
    const targetHandles = container.querySelectorAll('.react-flow__handle-top')
    const sourceHandles = container.querySelectorAll('.react-flow__handle-bottom')
    expect(targetHandles).toHaveLength(1)
    expect(sourceHandles).toHaveLength(1)
  })
})
