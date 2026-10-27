import { useCallback, useRef, useState, useEffect, type DragEvent } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type DefaultEdgeOptions,
  type Node,
  type Edge,
  BackgroundVariant,
} from '@xyflow/react'
import { OrchestratorNode } from './nodes/OrchestratorNode'
import { AssessorNode } from './nodes/AssessorNode'
import { ExecutorNode } from './nodes/ExecutorNode'
import { EndNode } from './nodes/EndNode'
import { ConditionNode } from './nodes/ConditionNode'
import { ApprovalNode } from './nodes/ApprovalNode'
import { Sidebar } from './components/Sidebar'
import { AvoidEdge } from './edges/AvoidEdge'
import { DebugPanel } from './components/DebugPanel'
import { isDraggableNodeType, AGENT_ITEMS, CONTROL_ITEMS } from './types'
import { createInitialExecutionState, walkStep, type ExecutionState } from './runtime'
import { buildOrchestratorInput, renderPrompt } from './prompt'
import { startRun, stopRun, approveStep, sendMessage } from './api'

// Normalize a string for fuzzy node matching (lowercase, strip non-alphanumeric)
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Try to extract a JSON object with a `state` key from a message string.
 * The orchestrator returns structured JSON containing state updates.
 */
function extractState(text: string): Record<string, unknown> | null {
  // Try parsing the whole message as JSON
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'state' in parsed) {
      return parsed.state as Record<string, unknown>
    }
  } catch { /* not valid JSON */ }

  // Try finding a JSON block in the text (```json ... ``` or { ... })
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/)
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1])
      if (parsed && typeof parsed === 'object' && 'state' in parsed) {
        return parsed.state as Record<string, unknown>
      }
    } catch { /* not valid JSON */ }
  }

  // Try finding a top-level JSON object
  const braceMatch = text.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0])
      if (parsed && typeof parsed === 'object' && 'state' in parsed) {
        return parsed.state as Record<string, unknown>
      }
    } catch { /* not valid JSON */ }
  }

  return null
}

const nodeTypes = {
  orchestrator: OrchestratorNode,
  assessor: AssessorNode,
  executor: ExecutorNode,
  end: EndNode,
  condition: ConditionNode,
  approval: ApprovalNode,
}

const edgeTypes = {
  avoid: AvoidEdge,
}

const defaultEdgeOptions: DefaultEdgeOptions = {
  animated: true,
  type: 'avoid',
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 16,
    height: 16,
    color: '#4a4a6a',
  },
  style: { stroke: '#4a4a6a', strokeWidth: 2 },
}

const initialNodes: Node[] = [
  {
    id: 'orchestrator-1',
    type: 'orchestrator',
    position: { x: 300, y: 180 },
    data: {
      label: 'Orchestrator',
      description: 'Hangman game controller',
      prompt: 'You are the hangman game controller. You MUST delegate tasks to your instruments — never perform them yourself. To pick a word, call the Pick Word instrument. To get a guess, call the Guess Letter instrument. You only manage state transitions: when an instrument returns, update state (guessedLetters, wrongCount, gameOver) based on the result. Follow the transition conditions to decide the next step. Display the masked word and remaining lives after each state update.',
      maxEdges: 1,
      stateFields: [
        { name: 'word', type: 'string' },
        { name: 'guessedLetters', type: 'string[]' },
        { name: 'wrongCount', type: 'number' },
        { name: 'maxWrong', type: 'number' },
        { name: 'gameOver', type: 'boolean' },
      ],
    },
    deletable: false,
  },
  {
    id: 'instrument-2',
    type: 'assessor',
    position: { x: 80, y: 400 },
    data: {
      label: 'Pick Word',
      description: 'Selects a secret word',
      prompt: 'Pick a random common English word (5-7 letters). Return the word. Do NOT reveal it to the user.',
    },
  },
  {
    id: 'instrument-3',
    type: 'approval',
    position: { x: 520, y: 400 },
    data: {
      label: 'Guess Letter',
      description: 'Wait for player to guess',
      prompt: 'Ask the player to guess a letter. Return their guess.',
    },
  },
  {
    id: 'instrument-4',
    type: 'end',
    position: { x: 300, y: 580 },
    data: {
      label: 'End',
      description: 'Game finished',
    },
  },
]

const initialEdges: Edge[] = [
  { id: 'e-orch-pick', source: 'orchestrator-1', target: 'instrument-2', type: 'avoid', data: { label: 'word is not set' } },
  { id: 'e-pick-orch', source: 'instrument-2', target: 'orchestrator-1', type: 'avoid', data: { label: 'word picked' } },
  { id: 'e-orch-guess', source: 'orchestrator-1', target: 'instrument-3', type: 'avoid', data: { label: 'word is set, not game over' } },
  { id: 'e-guess-orch', source: 'instrument-3', target: 'orchestrator-1', type: 'avoid', data: { label: 'letter received' } },
  { id: 'e-orch-end', source: 'orchestrator-1', target: 'instrument-4', type: 'avoid', data: { label: 'game over' } },
]

let nodeId = 4

function getNextId() {
  return `instrument-${++nodeId}`
}

const allPaletteItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]

export default function App() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const { screenToFlowPosition } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [execution, setExecution] = useState<ExecutionState>(createInitialExecutionState(false))

  // Apply active/visited classes to nodes based on execution state
  const isExecuting = execution.status === 'running' || execution.status === 'paused'
  const styledNodes = nodes.map((n) => {
    const isActive = execution.activeNodeId === n.id
    const isVisited = execution.visitedNodeIds.includes(n.id) && !isActive
    const className = [
      isActive ? 'node-active' : '',
      isVisited ? 'node-visited' : '',
    ].filter(Boolean).join(' ') || undefined

    return {
      ...n,
      ...(className ? { className } : {}),
      // Clear selection highlight during execution so it doesn't compete with active/visited
      ...(isExecuting ? { selected: false } : {}),
    }
  })

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((eds) => {
        const sourceNode = nodes.find((n) => n.id === params.source)
        const rawMaxEdges = sourceNode?.data.maxEdges
        const maxEdges = typeof rawMaxEdges === 'number' ? rawMaxEdges : null

        if (maxEdges === 0) return eds

        if (maxEdges != null) {
          const filtered = eds.filter((e) => e.source !== params.source)
          return addEdge(params, filtered)
        }

        return addEdge(params, eds)
      }),
    [setEdges, nodes],
  )

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) =>
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds)),
    [setEdges],
  )

  const onEdgeDoubleClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const current = (edge.data?.label as string) ?? ''
      const label = window.prompt('Edge condition (leave empty to remove):', current)
      if (label === null) return // cancelled
      setEdges((eds) =>
        eds.map((e) =>
          e.id === edge.id ? { ...e, data: { ...e.data, label: label || undefined } } : e
        ),
      )
    },
    [setEdges],
  )

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()

      const raw = event.dataTransfer.getData('application/reactflow')
      if (!isDraggableNodeType(raw)) return
      const type = raw

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      const paletteItem = allPaletteItems.find((p) => p.type === type)
      if (!paletteItem) return

      const newNode: Node = {
        id: getNextId(),
        type,
        position,
        data: {
          label: paletteItem.label,
          description: paletteItem.description,
          maxEdges: paletteItem.maxEdges,
        },
      }

      setNodes((nds) => [...nds, newNode])
    },
    [setNodes],
  )

  const onExport = useCallback(() => {
    const workflow = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: String(n.data.label ?? ''),
        description: String(n.data.description ?? ''),
        prompt: String(n.data.prompt ?? ''),
        ...(Array.isArray(n.data.stateFields) && n.data.stateFields.length > 0
          ? { stateFields: n.data.stateFields }
          : {}),
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
    }
    const json = JSON.stringify(workflow, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'workflow.json'
    a.click()
    URL.revokeObjectURL(url)
  }, [nodes, edges])

  const onRun = useCallback((debug: boolean) => {
    console.log(`[symphony:ui] onRun called — debug=${debug}, nodes=${nodes.length}, edges=${edges.length}`)
    // Build the prompt from the graph
    const promptNodes = nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: String(n.data.label ?? ''),
      description: String(n.data.description ?? ''),
      prompt: String(n.data.prompt ?? ''),
      stateFields: n.data.stateFields as { name: string; type: string }[] | undefined,
    }))
    const promptEdges = edges.map((e) => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      label: e.data?.label as string | undefined,
    }))

    let sdkPrompt: string | null = null
    try {
      const input = buildOrchestratorInput(promptNodes, promptEdges)
      sdkPrompt = renderPrompt(input)
      console.log(`[symphony:ui] Prompt built successfully (${sdkPrompt.length} chars)`)
    } catch (err) {
      console.warn('[symphony:ui] Prompt build failed:', err)
      // If prompt building fails, still do the graph walk
    }

    // Initialize execution with the prompt
    const initial = createInitialExecutionState(debug)
    initial.sdkPrompt = sdkPrompt
    setExecution(initial)

    // In debug mode, wait for the user to press Step; otherwise auto-walk
    if (!debug) {
      console.log('[symphony:ui] Non-debug mode — auto-walking first step')
      setExecution((prev) => walkStep(prev, nodes, edges))
    } else {
      console.log('[symphony:ui] Debug mode — orchestrator is active')
      // Mark orchestrator as the active node so it highlights immediately
      const orchestratorNode = nodes.find((n) => n.type === 'orchestrator')
      setExecution((prev) => ({
        ...prev,
        status: 'running',
        activeNodeId: orchestratorNode?.id ?? null,
      }))
    }

    // Start the SDK session
    if (sdkPrompt) {
      console.log('[symphony:ui] Starting SDK session…')
      // Collect allowed instrument names from the graph (non-orchestrator, non-end nodes)
      const allowedInstruments = nodes
        .filter((n) => n.type !== 'orchestrator' && n.type !== 'end')
        .map((n) => String(n.data.label))
      const controller = startRun(sdkPrompt, {
        onSessionId: (id) => {
          console.log(`[symphony:ui] SDK session started — id=${id}`)
          setExecution((prev) => ({ ...prev, sdkSessionId: id }))
        },
        onMessage: (content) => {
          console.log(`[symphony:ui] SDK message received (${content.length} chars)`)
          setExecution((prev) => {
            const next = {
              ...prev,
              sdkMessages: [...prev.sdkMessages, content],
              sessionLogs: [...prev.sessionLogs, {
                type: 'orchestrator' as const,
                timestamp: Date.now(),
                agent: 'Orchestrator',
                content,
              }],
            }
            return next
          })
        },
        onTurnDone: () => {
          console.log('[symphony:ui] SDK turn done')
          const orchestratorNode = nodes.find((n) => n.type === 'orchestrator')
          setExecution((prev) => {
            // Auto-continue: if the session is still running, prompt the orchestrator to keep going
            if (prev.sdkSessionId && prev.status === 'running') {
              console.log('[symphony:ui] Auto-continuing — sending follow-up to orchestrator')
              sendMessage(prev.sdkSessionId, 'Continue. Call the next instrument in the workflow.').catch((err) => {
                console.error('[symphony:ui] Auto-continue failed:', err)
              })
            }
            return {
              ...prev,
              activeNodeId: orchestratorNode?.id ?? prev.activeNodeId,
            }
          })
        },
        onToolStart: (_toolName, toolArgs) => {
          // toolArgs may be a JSON string or object
          const args: Record<string, unknown> = typeof toolArgs === 'string'
            ? (() => { try { return JSON.parse(toolArgs) } catch { return {} } })()
            : (toolArgs as Record<string, unknown>) ?? {}
          const argsStr = JSON.stringify(args)
          console.log(`[symphony:ui] Tool started — matching against nodes`)
          const normalizedArgs = normalize(argsStr)
          const matchedNode = nodes.find(
            (n) => n.type !== 'orchestrator' && n.data.label && normalizedArgs.includes(normalize(String(n.data.label)))
          )
          const displayLabel = matchedNode ? String(matchedNode.data.label) : ((args.name as string) ?? _toolName)
          const prompt = (args.prompt as string) ?? (args.description as string) ?? undefined
          const logContent = `Orchestrator → ${displayLabel}`
          const logDetails = prompt
            ? `[LLM decision] "${prompt}"`
            : `[LLM decision] args: ${argsStr}`
          if (matchedNode) {
            console.log(`[symphony:ui] Activating node: ${matchedNode.data.label} (${matchedNode.id})`)
            setExecution((prev) => ({
              ...prev,
              activeNodeId: matchedNode.id,
              awaitingInput: false,
              visitedNodeIds: prev.activeNodeId && !prev.visitedNodeIds.includes(prev.activeNodeId)
                ? [...prev.visitedNodeIds, prev.activeNodeId]
                : prev.visitedNodeIds,
              sessionLogs: [...prev.sessionLogs, {
                type: 'tool-start' as const,
                timestamp: Date.now(),
                agent: displayLabel,
                content: logContent,
                details: logDetails,
              }],
            }))
          } else {
            setExecution((prev) => ({
              ...prev,
              sessionLogs: [...prev.sessionLogs, {
                type: 'tool-start' as const,
                timestamp: Date.now(),
                agent: displayLabel,
                content: logContent,
                details: logDetails,
              }],
            }))
          }
        },
        onToolEnd: (_toolName, agentName, result) => {
          console.log(`[symphony:ui] Tool ended (agent=${agentName}) — returning to orchestrator`)
          const orchestratorNode = nodes.find((n) => n.type === 'orchestrator')
          setExecution((prev) => {
            const next = {
              ...prev,
              activeNodeId: orchestratorNode?.id ?? prev.activeNodeId,
              visitedNodeIds: prev.activeNodeId && !prev.visitedNodeIds.includes(prev.activeNodeId)
                ? [...prev.visitedNodeIds, prev.activeNodeId]
                : prev.visitedNodeIds,
              sessionLogs: [...prev.sessionLogs, {
                type: 'tool-end' as const,
                timestamp: Date.now(),
                agent: agentName ?? _toolName,
                content: `${agentName ?? _toolName} completed`,
                details: result ?? undefined,
              }],
            }
            // Try to extract state from tool result
            if (result) {
              const newState = extractState(result)
              if (newState) {
                console.log(`[symphony:ui] State extracted from ${agentName} result:`, JSON.stringify(newState))
                next.state = { ...prev.state, ...newState }
                next.sessionLogs = [...next.sessionLogs, {
                  type: 'state-change' as const,
                  timestamp: Date.now(),
                  content: `State updated by ${agentName ?? _toolName}`,
                  details: JSON.stringify(newState, null, 2),
                }]
              }
            }
            return next
          })
        },
        onStepPending: (toolName, toolArgs) => {
          console.log(`[symphony:ui] Step pending — tool=${toolName}, waiting for user Step click`)
          const args: Record<string, unknown> = typeof toolArgs === 'string'
            ? (() => { try { return JSON.parse(toolArgs) } catch { return {} } })()
            : (toolArgs as Record<string, unknown>) ?? {}
          const argsStr = JSON.stringify(args)
          const normalizedArgs = normalize(argsStr)
          const matchedNode = nodes.find(
            (n) => n.type !== 'orchestrator' && n.data.label && normalizedArgs.includes(normalize(String(n.data.label)))
          )
          const isApproval = matchedNode?.type === 'approval'
          const displayLabel = matchedNode ? String(matchedNode.data.label) : ((args.name as string) ?? toolName)
          const prompt = (args.prompt as string) ?? (args.description as string) ?? undefined
          const logDetails = prompt
            ? `[LLM decision] "${prompt}"`
            : `[LLM decision] args: ${argsStr}`
          // Don't move activeNodeId — keep focus on orchestrator until user clicks Step
          setExecution((prev) => ({
            ...prev,
            status: 'paused',
            awaitingInput: isApproval,
            sessionLogs: [...prev.sessionLogs, {
              type: 'orchestrator' as const,
              timestamp: Date.now(),
              agent: 'Orchestrator',
              content: isApproval
                ? `⏸ Wants to call ${displayLabel} — waiting for your input`
                : `Wants to call ${displayLabel} — click Step to approve`,
              details: logDetails,
            }],
          }))
        },
        onError: (message) => {
          console.error(`[symphony:ui] SDK error: ${message}`)
          setExecution((prev) => ({
            ...prev,
            status: 'error',
            error: message,
            sessionLogs: [...prev.sessionLogs, {
              type: 'error' as const,
              timestamp: Date.now(),
              content: message,
            }],
          }))
        },
      }, debug, allowedInstruments)
      abortRef.current = controller
    } else {
      console.warn('[symphony:ui] No SDK prompt — skipping SDK session')
    }
  }, [nodes, edges])

  const onStep = useCallback(() => {
    console.log(`[symphony:ui] onStep called — status=${execution.status}, sdkSessionId=${execution.sdkSessionId}, activeNode=${execution.activeNodeId}`)
    // If the SDK session is paused waiting for approval, approve the step
    if (execution.sdkSessionId && execution.status === 'paused') {
      console.log('[symphony:ui] Approving pending SDK step')
      setExecution((prev) => ({ ...prev, status: 'running' }))
      approveStep(execution.sdkSessionId).catch((err) => {
        console.error('[symphony:ui] approveStep failed:', err)
      })
      return
    }
    // When SDK is active, graph walk is disabled — SDK drives execution
    if (execution.sdkSessionId) {
      console.log('[symphony:ui] SDK session active — step ignored (SDK drives execution)')
      return
    }
    // No SDK session — do a graph walk step
    setExecution((prev) => {
      const next = walkStep(prev, nodes, edges)
      console.log(`[symphony:ui] Step result — status=${next.status}, activeNode=${next.activeNodeId}`)
      return next
    })
  }, [nodes, edges, execution.sdkSessionId, execution.status, execution.activeNodeId])

  const onResume = useCallback(() => {
    // Resume from approval pause — step to next node
    setExecution((prev) => {
      if (prev.status !== 'paused') return prev
      return walkStep({ ...prev, status: 'running' }, nodes, edges)
    })
  }, [nodes, edges])

  const onStop = useCallback(() => {
    console.log(`[symphony:ui] onStop called — sdkSessionId=${execution.sdkSessionId}`)
    // Abort SDK request
    abortRef.current?.abort()
    abortRef.current = null
    // Stop SDK session on the server
    const sessionId = execution.sdkSessionId
    if (sessionId) {
      stopRun(sessionId)
    }
    setExecution((prev) => createInitialExecutionState(prev.debug))
  }, [execution.sdkSessionId])

  // Auto-step when running (not paused/completed/error) — skip in debug mode and when SDK is active
  useEffect(() => {
    if (execution.debug) return
    if (execution.sdkSessionId) return // SDK drives execution, not graph walk
    if (execution.status !== 'running' || execution.activeNodeId === null) return
    console.log(`[symphony:ui] Auto-step effect firing — activeNode=${execution.activeNodeId}`)

    const currentNode = nodes.find((n) => n.id === execution.activeNodeId)
    if (!currentNode) return

    // Don't auto-step on approval nodes (wait for user) or end nodes
    if (currentNode.type === 'approval' || currentNode.type === 'end') return

    const timer = setTimeout(() => {
      setExecution((prev) => {
        const next = walkStep(prev, nodes, edges)
        return next
      })
    }, 800)

    return () => clearTimeout(timer)
  }, [execution.status, execution.activeNodeId, execution.sdkSessionId, execution.debug, nodes, edges])

  // Reset to idle when run completes
  useEffect(() => {
    if (execution.status !== 'completed') return
    console.log('[symphony:ui] Completed — resetting to idle in 1s')

    const timer = setTimeout(() => {
      console.log('[symphony:ui] Resetting to idle now')
      setExecution((prev) => createInitialExecutionState(prev.debug))
    }, 1000)

    return () => clearTimeout(timer)
  }, [execution.status])

  return (
    <div className="app">
      <Sidebar
        onExport={onExport}
        onRun={onRun}
        onStep={onStep}
        onResume={onResume}
        onStop={onStop}
        execution={execution}
      />
      <div className="canvas" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={styledNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          edgesReconnectable
          fitView
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a4a" />
          <Controls />
          <MiniMap
            nodeColor={(n) => {
              if (n.type === 'orchestrator') return '#888'
              if (n.type === 'assessor') return '#4fc3f7'
              if (n.type === 'executor') return '#ce93d8'
              if (n.type === 'end') return '#ef5350'
              if (n.type === 'condition') return '#ffb74d'
              if (n.type === 'approval') return '#66bb6a'
              return '#666'
            }}
          />
        </ReactFlow>
      </div>
      {execution.debug && execution.status !== 'idle' && (
        <DebugPanel execution={execution} />
      )}
    </div>
  )
}
