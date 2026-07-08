import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect } from 'vitest'
import { OrchestratorNode } from './OrchestratorNode'
import type { StateField } from '../types'

function renderNode(opts: { prompt?: string; stateFields?: StateField[] } = {}) {
  return render(
    <ReactFlowProvider>
      <OrchestratorNode
        id="orchestrator-1"
        type="orchestrator"
        data={{ label: 'Orchestrator', description: 'Entry point', ...opts }}
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

describe('OrchestratorNode', () => {
  it('renders label and description', () => {
    renderNode()
    expect(screen.getByText('Orchestrator')).toBeInTheDocument()
    expect(screen.getByText('Entry point')).toBeInTheDocument()
  })

  it('has the orchestrator class', () => {
    renderNode()
    const node = screen.getByText('Orchestrator').closest('.workflow-node')
    expect(node).toHaveClass('orchestrator')
  })

  it('has only a source handle (no target — it is the start)', () => {
    renderNode()
    expect(screen.getByTestId('handle-source')).toBeInTheDocument()
    expect(screen.queryByTestId('handle-target')).not.toBeInTheDocument()
  })

  it('renders a prompt textarea', () => {
    renderNode()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toBeInTheDocument()
    expect(textarea.tagName).toBe('TEXTAREA')
  })

  it('displays the prompt value', () => {
    renderNode({ prompt: 'Investigate auth module' })
    expect(screen.getByTestId('node-prompt')).toHaveValue('Investigate auth module')
  })

  it('shows placeholder when prompt is empty', () => {
    renderNode()
    const textarea = screen.getByTestId('node-prompt')
    expect(textarea).toHaveAttribute('placeholder', 'Main prompt — what should this workflow accomplish?')
  })

  it('defaults to empty string when prompt is undefined', () => {
    renderNode()
    expect(screen.getByTestId('node-prompt')).toHaveValue('')
  })

  it('textarea has the node-prompt class', () => {
    renderNode()
    expect(screen.getByTestId('node-prompt')).toHaveClass('node-prompt')
  })

  it('renders the state section', () => {
    renderNode()
    expect(screen.getByTestId('state-section')).toBeInTheDocument()
  })

  it('renders the add state field button', () => {
    renderNode()
    expect(screen.getByTestId('state-add')).toBeInTheDocument()
    expect(screen.getByTestId('state-add')).toHaveTextContent('+')
  })

  it('shows no state fields by default', () => {
    renderNode()
    expect(screen.queryAllByTestId('state-field')).toHaveLength(0)
  })

  it('renders provided state fields', () => {
    renderNode({
      stateFields: [
        { name: 'word', type: 'string' },
        { name: 'guessedLetters', type: 'string[]' },
      ],
    })
    const fields = screen.getAllByTestId('state-field')
    expect(fields).toHaveLength(2)
  })

  it('displays state field names and types', () => {
    renderNode({
      stateFields: [{ name: 'score', type: 'number' }],
    })
    const nameInput = screen.getByTestId('state-field-name')
    const typeSelect = screen.getByTestId('state-field-type')
    expect(nameInput).toHaveValue('score')
    expect(typeSelect).toHaveValue('number')
  })

  it('renders a remove button for each state field', () => {
    renderNode({
      stateFields: [
        { name: 'a', type: 'string' },
        { name: 'b', type: 'number' },
      ],
    })
    const removeButtons = screen.getAllByTestId('state-field-remove')
    expect(removeButtons).toHaveLength(2)
  })

  it('state field type select contains expected options', () => {
    renderNode({
      stateFields: [{ name: 'x', type: 'string' }],
    })
    const select = screen.getByTestId('state-field-type')
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value)
    expect(options).toEqual(['string', 'number', 'boolean', 'string[]', 'number[]', 'object'])
  })

  it('new fields default to type string', () => {
    renderNode({
      stateFields: [{ name: '', type: 'string' }],
    })
    expect(screen.getByTestId('state-field-type')).toHaveValue('string')
  })

  it('workflow-node is inside a selected wrapper when selected', () => {
    render(
      <ReactFlowProvider>
        <OrchestratorNode
          id="orchestrator-1"
          type="orchestrator"
          data={{ label: 'Orchestrator', description: 'Entry point' }}
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
    const node = screen.getByText('Orchestrator').closest('.workflow-node')
    expect(node).toBeInTheDocument()
    expect(node).toHaveClass('workflow-node', 'orchestrator')
  })
})
