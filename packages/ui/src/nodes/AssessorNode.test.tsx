import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { AssessorNode } from './AssessorNode'

function renderNode() {
  return render(
    <ReactFlowProvider>
      <AssessorNode
        id="assessor-1"
        type="assessor"
        data={{ label: 'Assessor', description: 'Read-only evidence gatherer' }}
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
    const { container } = renderNode()
    const targetHandles = container.querySelectorAll('.react-flow__handle-top')
    const sourceHandles = container.querySelectorAll('.react-flow__handle-bottom')
    expect(targetHandles).toHaveLength(1)
    expect(sourceHandles).toHaveLength(1)
  })
})
