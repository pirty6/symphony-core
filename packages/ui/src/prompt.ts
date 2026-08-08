import type { StateField } from './types'

interface PromptNode {
  id: string
  type?: string
  label: string
  description: string
  prompt: string
  stateFields?: StateField[]
}

interface PromptEdge {
  source: string
  target: string
  sourceHandle?: string | null
  label?: string
}

export interface StateMachineNode {
  id: string
  type: string
  label: string
  prompt: string
  transitions: { target: string; condition?: string }[]
}

export interface OrchestratorInput {
  directive: string
  instruments: { type: string; label: string; prompt: string }[]
  nodes: StateMachineNode[]
  stateFields: StateField[]
  state: Record<string, unknown>
}

/**
 * Convert a visual graph (nodes + edges) into a structured OrchestratorInput
 * that describes a state machine for the Copilot SDK session.
 */
export function buildOrchestratorInput(
  nodes: PromptNode[],
  edges: PromptEdge[],
  state: Record<string, unknown> = {},
): OrchestratorInput {
  const orchestrator = nodes.find((n) => n.type === 'orchestrator')
  if (!orchestrator) {
    throw new Error('No orchestrator node found in graph')
  }

  const stateFields = orchestrator.stateFields ?? []
  const directive = orchestrator.prompt || orchestrator.description

  // Collect instruments (assessor/executor nodes)
  const instrumentTypes = new Set(['assessor', 'executor'])
  const instruments = nodes
    .filter((n) => instrumentTypes.has(n.type ?? ''))
    .map((n) => ({
      type: n.type!,
      label: n.label,
      prompt: n.prompt,
    }))

  // Build state machine nodes with transitions from edges
  const smNodes: StateMachineNode[] = nodes.map((n) => {
    const outEdges = edges.filter((e) => e.source === n.id)
    const transitions = outEdges.map((e) => {
      const targetNode = nodes.find((t) => t.id === e.target)
      const targetLabel = targetNode ? `${targetNode.type}:${targetNode.label}` : e.target
      // Condition comes from edge label first, then sourceHandle for condition nodes
      const condition = e.label || (e.sourceHandle === 'then' ? 'then' : e.sourceHandle === 'else' ? 'else' : undefined)
      return condition ? { target: targetLabel, condition } : { target: targetLabel }
    })
    return {
      id: n.id,
      type: n.type ?? 'unknown',
      label: n.label,
      prompt: n.prompt || n.description,
      transitions,
    }
  })

  return { directive, instruments, nodes: smNodes, stateFields, state }
}

/**
 * Render OrchestratorInput into the text prompt sent to the Copilot SDK session.
 */
export function renderPrompt(input: OrchestratorInput): string {
  const lines: string[] = []

  lines.push('## Directive')
  lines.push(input.directive)
  lines.push('')

  lines.push('## Execution Model')
  lines.push('This is a STATE MACHINE. You are the orchestrator. Follow the transitions below.')
  lines.push('You move through nodes one at a time based on state and conditions.')
  lines.push('')

  lines.push('### Node Types')
  lines.push('- **orchestrator**: Entry point. You start here. Delegate work via `task` tool calls.')
  lines.push('- **assessor**: Read-only sub-agent. Call via `task` tool. Returns data without side effects.')
  lines.push('- **executor**: Write sub-agent. Call via `task` tool. Performs actions with side effects.')
  lines.push('- **approval**: PAUSE and wait for human input. Report current state and ask the user to respond. Do NOT proceed until the user sends a message.')
  lines.push('- **condition**: Evaluate a condition against current state. Follow "then" or "else" transition.')
  lines.push('- **end**: Terminal state. Report final results and stop.')
  lines.push('')

  if (input.instruments.length > 0) {
    lines.push('## Instruments')
    lines.push('You MUST delegate work to instruments by calling the `task` tool.')
    lines.push('Do NOT perform instrument work yourself.')
    lines.push('')
    for (const inst of input.instruments) {
      lines.push(`- ${inst.type} "${inst.label}": ${inst.prompt || '(no prompt)'}`)
    }
    lines.push('')
  }

  lines.push('## State Machine')
  for (const node of input.nodes) {
    const transStr = node.transitions.length > 0
      ? node.transitions.map((t) =>
          t.condition ? `→ ${t.target} [${t.condition}]` : `→ ${t.target}`
        ).join(', ')
      : '(terminal)'
    lines.push(`- **${node.type}:${node.label}** — ${node.prompt} | ${transStr}`)
  }
  lines.push('')

  if (input.stateFields.length > 0) {
    lines.push('## State Schema')
    for (const field of input.stateFields) {
      lines.push(`- ${field.name}: ${field.type}`)
    }
    lines.push('')
  }

  if (Object.keys(input.state).length > 0) {
    lines.push('## Current State')
    lines.push('```json')
    lines.push(JSON.stringify(input.state, null, 2))
    lines.push('```')
    lines.push('')
  }

  return lines.join('\n')
}
