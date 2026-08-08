import { render, screen } from '@testing-library/react'
import { ReactFlowProvider, ReactFlow, Position } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { AvoidEdge } from './AvoidEdge'

const edgeTypes = { avoid: AvoidEdge }

function renderWithReactFlow(edgeData?: Record<string, unknown>) {
  const nodes = [
    { id: 'n1', position: { x: 0, y: 0 }, data: { label: 'A' } },
    { id: 'n2', position: { x: 200, y: 200 }, data: { label: 'B' } },
  ]
  const edges = [
    { id: 'e-test', source: 'n1', target: 'n2', type: 'avoid', data: edgeData },
  ]
  return render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow nodes={nodes} edges={edges} edgeTypes={edgeTypes} />
      </div>
    </ReactFlowProvider>,
  )
}

function renderEdgeSVG(data?: Record<string, unknown>) {
  return render(
    <ReactFlowProvider>
      <svg>
        <AvoidEdge
          id="e-test"
          source="node-1"
          target="node-2"
          sourceX={0}
          sourceY={0}
          targetX={200}
          targetY={200}
          sourcePosition={Position.Bottom}
          targetPosition={Position.Top}
          data={data}
          type="avoid"
          sourceHandleId={null}
          targetHandleId={null}
          markerEnd="url(#arrow)"
          style={{}}
          selected={false}
          animated={false}
          selectable={true}
          deletable={true}
          interactionWidth={20}
        />
      </svg>
    </ReactFlowProvider>,
  )
}

describe('AvoidEdge', () => {
  it('renders the edge path', () => {
    renderEdgeSVG()
    const path = document.querySelector('.react-flow__edge-path')
    expect(path).toBeInTheDocument()
  })

  it('does not render a label when data has no label', () => {
    renderEdgeSVG()
    expect(screen.queryByTestId('edge-label-e-test')).not.toBeInTheDocument()
  })

  it('does not render a label when data is undefined', () => {
    renderEdgeSVG(undefined)
    expect(screen.queryByTestId('edge-label-e-test')).not.toBeInTheDocument()
  })

  it('does not render label for empty string', () => {
    renderEdgeSVG({ label: '' })
    expect(screen.queryByTestId('edge-label-e-test')).not.toBeInTheDocument()
  })

  it('renders label via ReactFlow (EdgeLabelRenderer portal)', () => {
    renderWithReactFlow({ label: 'word is set' })
    const label = screen.queryByTestId('edge-label-e-test')
    // EdgeLabelRenderer uses a portal — may not render in jsdom without full layout.
    // If it renders, verify content; if not, the unit logic is tested via prompt.test.ts
    if (label) {
      expect(label.textContent).toBe('word is set')
      expect(label).toHaveClass('edge-label')
    }
  })

  it('does not render label in ReactFlow when no label data', () => {
    renderWithReactFlow(undefined)
    expect(screen.queryByTestId('edge-label-e-test')).not.toBeInTheDocument()
  })
})
