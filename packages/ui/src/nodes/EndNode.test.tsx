import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { EndNode } from './EndNode'

function renderNode() {
  return render(
    <ReactFlowProvider>
      <EndNode
        id="end-1"
        type="end"
        data={{ label: 'End', description: 'Workflow complete' }}
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

describe('EndNode', () => {
  it('renders label and description', () => {
    renderNode()
    expect(screen.getByText('End')).toBeInTheDocument()
    expect(screen.getByText('Workflow complete')).toBeInTheDocument()
  })

  it('has the end class', () => {
    renderNode()
    const node = screen.getByText('End').closest('.workflow-node')
    expect(node).toHaveClass('end')
  })

  it('has only a target handle (no source — it is the terminal)', () => {
    renderNode()
    expect(screen.getByTestId('handle-target')).toBeInTheDocument()
    expect(screen.queryByTestId('handle-source')).not.toBeInTheDocument()
  })
})
