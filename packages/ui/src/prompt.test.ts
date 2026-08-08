import { describe, it, expect } from 'vitest'
import { buildOrchestratorInput, renderPrompt } from './prompt'

describe('buildOrchestratorInput', () => {
  const nodes = [
    { id: 'orch', type: 'orchestrator', label: 'Orchestrator', description: 'Entry point', prompt: 'Analyze the code', stateFields: [{ name: 'result', type: 'string' as const }] },
    { id: 'assess', type: 'assessor', label: 'Assessor', description: 'Read-only', prompt: 'Investigate the issue' },
    { id: 'exec', type: 'executor', label: 'Executor', description: 'Write', prompt: 'Apply the fix' },
    { id: 'end', type: 'end', label: 'End', description: 'Done', prompt: '' },
  ]
  const edges = [
    { source: 'orch', target: 'assess' },
    { source: 'assess', target: 'exec' },
    { source: 'exec', target: 'end' },
  ]

  it('extracts the directive from the orchestrator prompt', () => {
    const input = buildOrchestratorInput(nodes, edges)
    expect(input.directive).toBe('Analyze the code')
  })

  it('falls back to description when prompt is empty', () => {
    const noPrompt = nodes.map((n) =>
      n.id === 'orch' ? { ...n, prompt: '' } : n,
    )
    const input = buildOrchestratorInput(noPrompt, edges)
    expect(input.directive).toBe('Entry point')
  })

  it('collects assessor and executor instruments', () => {
    const input = buildOrchestratorInput(nodes, edges)
    expect(input.instruments).toHaveLength(2)
    expect(input.instruments[0]).toEqual({
      type: 'assessor',
      label: 'Assessor',
      prompt: 'Investigate the issue',
    })
    expect(input.instruments[1]).toEqual({
      type: 'executor',
      label: 'Executor',
      prompt: 'Apply the fix',
    })
  })

  it('includes state fields from orchestrator', () => {
    const input = buildOrchestratorInput(nodes, edges)
    expect(input.stateFields).toEqual([{ name: 'result', type: 'string' }])
  })

  it('builds state machine nodes with transitions', () => {
    const input = buildOrchestratorInput(nodes, edges)
    expect(input.nodes).toHaveLength(4)

    const orch = input.nodes.find((n) => n.type === 'orchestrator')!
    expect(orch.transitions).toEqual([{ target: 'assessor:Assessor' }])

    const assess = input.nodes.find((n) => n.type === 'assessor')!
    expect(assess.transitions).toEqual([{ target: 'executor:Executor' }])

    const end = input.nodes.find((n) => n.type === 'end')!
    expect(end.transitions).toEqual([])
  })

  it('captures condition branches as then/else transitions', () => {
    const condNodes = [
      { id: 'orch', type: 'orchestrator', label: 'Orch', description: 'Entry', prompt: 'Go' },
      { id: 'cond', type: 'condition', label: 'Check', description: 'Branch', prompt: 'Is it done?' },
      { id: 'yes', type: 'end', label: 'Done', description: '', prompt: '' },
      { id: 'no', type: 'assessor', label: 'Retry', description: '', prompt: 'Try again' },
    ]
    const condEdges = [
      { source: 'orch', target: 'cond' },
      { source: 'cond', target: 'yes', sourceHandle: 'then' },
      { source: 'cond', target: 'no', sourceHandle: 'else' },
    ]
    const input = buildOrchestratorInput(condNodes, condEdges)
    const cond = input.nodes.find((n) => n.type === 'condition')!
    expect(cond.transitions).toEqual([
      { target: 'end:Done', condition: 'then' },
      { target: 'assessor:Retry', condition: 'else' },
    ])
  })

  it('uses edge labels as transition conditions', () => {
    const input = buildOrchestratorInput(
      [
        { id: 'orch', type: 'orchestrator', label: 'Orch', description: 'Entry', prompt: 'Go' },
        { id: 'a', type: 'assessor', label: 'Pick', description: '', prompt: 'Pick word' },
        { id: 'appr', type: 'approval', label: 'Guess', description: '', prompt: 'Enter guess' },
      ],
      [
        { source: 'orch', target: 'a', label: 'word is not set' },
        { source: 'a', target: 'appr', label: 'word is set' },
      ],
    )
    const orch = input.nodes.find((n) => n.type === 'orchestrator')!
    expect(orch.transitions).toEqual([{ target: 'assessor:Pick', condition: 'word is not set' }])
    const assess = input.nodes.find((n) => n.type === 'assessor')!
    expect(assess.transitions).toEqual([{ target: 'approval:Guess', condition: 'word is set' }])
  })

  it('throws if no orchestrator node', () => {
    const noOrch = nodes.filter((n) => n.type !== 'orchestrator')
    expect(() => buildOrchestratorInput(noOrch, edges)).toThrow('No orchestrator node found')
  })

  it('accepts initial state', () => {
    const input = buildOrchestratorInput(nodes, edges, { result: 'hello' })
    expect(input.state).toEqual({ result: 'hello' })
  })
})

describe('renderPrompt', () => {
  it('renders a complete prompt with all sections', () => {
    const input = buildOrchestratorInput(
      [
        { id: 'orch', type: 'orchestrator', label: 'Orch', description: 'Entry', prompt: 'Do the thing', stateFields: [{ name: 'x', type: 'string' as const }] },
        { id: 'a', type: 'assessor', label: 'Assess', description: '', prompt: 'Look at it' },
      ],
      [{ source: 'orch', target: 'a' }],
      { x: 'hello' },
    )
    const prompt = renderPrompt(input)

    expect(prompt).toContain('## Directive')
    expect(prompt).toContain('Do the thing')
    expect(prompt).toContain('## Execution Model')
    expect(prompt).toContain('STATE MACHINE')
    expect(prompt).toContain('## Instruments')
    expect(prompt).toContain('assessor "Assess": Look at it')
    expect(prompt).toContain('## State Machine')
    expect(prompt).toContain('orchestrator:Orch')
    expect(prompt).toContain('assessor:Assess')
    expect(prompt).toContain('## State Schema')
    expect(prompt).toContain('- x: string')
    expect(prompt).toContain('## Current State')
    expect(prompt).toContain('"x": "hello"')
  })

  it('omits empty sections', () => {
    const input = buildOrchestratorInput(
      [{ id: 'orch', type: 'orchestrator', label: 'Orch', description: 'Entry', prompt: 'Go' }],
      [],
    )
    const prompt = renderPrompt(input)
    expect(prompt).toContain('## Directive')
    expect(prompt).not.toContain('## Instruments')
    expect(prompt).not.toContain('## Current State')
  })

  it('renders approval nodes with PAUSE semantics', () => {
    const input = buildOrchestratorInput(
      [
        { id: 'orch', type: 'orchestrator', label: 'Orch', description: 'Entry', prompt: 'Go' },
        { id: 'appr', type: 'approval', label: 'Wait', description: 'Needs input', prompt: 'Enter guess' },
      ],
      [{ source: 'orch', target: 'appr' }],
    )
    const prompt = renderPrompt(input)
    expect(prompt).toContain('approval:Wait')
    expect(prompt).toContain('PAUSE and wait for human input')
  })

  it('renders condition nodes with branching', () => {
    const input = buildOrchestratorInput(
      [
        { id: 'orch', type: 'orchestrator', label: 'Orch', description: 'Entry', prompt: 'Go' },
        { id: 'cond', type: 'condition', label: 'Check', description: '', prompt: 'Is it done?' },
        { id: 'yes', type: 'end', label: 'Done', description: '', prompt: '' },
        { id: 'no', type: 'assessor', label: 'Retry', description: '', prompt: 'Again' },
      ],
      [
        { source: 'orch', target: 'cond' },
        { source: 'cond', target: 'yes', sourceHandle: 'then' },
        { source: 'cond', target: 'no', sourceHandle: 'else' },
      ],
    )
    const prompt = renderPrompt(input)
    expect(prompt).toContain('condition:Check')
    expect(prompt).toContain('[then]')
    expect(prompt).toContain('[else]')
  })
})
