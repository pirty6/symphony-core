import { render, screen, fireEvent } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'
import { newNode, type FlowNode as FlowNodeType } from '../lib/model'
import { FlowNode } from './FlowNode'

function renderNode(node: FlowNodeType, extra: Partial<FlowNodeType['data']> = {}) {
  const props = { id: node.id, data: { ...node.data, ...extra }, selected: false } as unknown as NodeProps<FlowNodeType>
  return render(
    <ReactFlowProvider>
      <FlowNode {...props} />
    </ReactFlowProvider>,
  )
}

describe('FlowNode', () => {
  it('renders an agent with role, directive and data chips', () => {
    const n = newNode('assessor', 'gather', { x: 0, y: 0 })
    renderNode(n, { reads: ['question'], writes: ['findings'] })
    expect(screen.getByText('Assess')).toBeInTheDocument()
    expect(screen.getByText(/assessor · AI/)).toBeInTheDocument()
    expect(screen.getByText('question')).toHaveClass('chip-in')
    expect(screen.getByText('findings')).toHaveClass('chip-out')
  })

  it('shows run status, visits, gate and issues', () => {
    renderNode(newNode('executor', 'apply', { x: 0, y: 0 }), {
      status: 'paused',
      visits: 2,
      gate: 'after',
      issues: ['bad guard'],
    })
    const el = screen.getByTestId('node-apply')
    expect(el).toHaveClass('status-paused', 'has-issues', 'at-gate')
    expect(el).toHaveAttribute('title', 'bad guard')
    expect(screen.getByText('×2')).toBeInTheDocument()
    expect(screen.getByText(/AI answered: review before applying/)).toBeInTheDocument()
  })

  it('toggles breakpoints without selecting the node', () => {
    const onToggle = vi.fn()
    renderNode(newNode('compute', 'count', { x: 0, y: 0 }), { onToggleBreakpoint: onToggle, breakpoint: true })
    const bp = screen.getByLabelText('breakpoint count')
    expect(bp).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(bp)
    expect(onToggle).toHaveBeenCalledWith('count')
  })

  it('renders then/else handles for conditions and none for end', () => {
    const { container } = renderNode(newNode('condition', 'c', { x: 0, y: 0 }))
    expect(container.querySelectorAll('.react-flow__handle-bottom')).toHaveLength(2)
    expect(screen.getByText('then')).toBeInTheDocument()
    const end = renderNode(newNode('end', 'e', { x: 0, y: 0 }))
    expect(end.container.querySelectorAll('.react-flow__handle-bottom')).toHaveLength(0)
    expect(screen.queryByLabelText('breakpoint e')).toBeNull()
  })

  it('shows tool nodes and agent capabilities and checks', () => {
    const tool = newNode('tool', 'inventory', { x: 0, y: 0 })
    renderNode(tool, { writes: ['repoFiles'] })
    expect(screen.getByText('repo.files')).toBeInTheDocument()
    expect(screen.getByText('repoFiles')).toHaveClass('chip-out')
    const agent = newNode('assessor', 'sweep', { x: 0, y: 0 })
    const node = { ...agent.data.node, capabilities: ['web', 'mcp'], checks: [{ expr: 'len(queries) > 0', message: 'm' }] } as typeof agent.data.node
    renderNode({ ...agent, data: { ...agent.data, node } })
    expect(screen.getByText('🌐 web')).toBeInTheDocument()
    expect(screen.getByText('🔌 mcp')).toBeInTheDocument()
    expect(screen.getByText('✓ 1 check')).toHaveAttribute('title', 'len(queries) > 0 — m')
  })
})

