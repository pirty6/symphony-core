import { useCallback, useRef, type DragEvent } from 'react'
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
import { isDraggableNodeType, AGENT_ITEMS, CONTROL_ITEMS } from './types'

const nodeTypes = {
  orchestrator: OrchestratorNode,
  assessor: AssessorNode,
  executor: ExecutorNode,
  end: EndNode,
  condition: ConditionNode,
  approval: ApprovalNode,
}

const defaultEdgeOptions: DefaultEdgeOptions = {
  animated: true,
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
    position: { x: 300, y: 50 },
    data: { label: 'Orchestrator', description: 'Entry point — routes to instruments', maxEdges: 1 },
    deletable: false,
  },
]

const initialEdges: Edge[] = []

let nodeId = 1

function getNextId() {
  return `instrument-${++nodeId}`
}

const allPaletteItems = [...AGENT_ITEMS, ...CONTROL_ITEMS]

export default function App() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

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

      const wrapperBounds = reactFlowWrapper.current?.getBoundingClientRect()
      if (!wrapperBounds) return

      const position = {
        x: event.clientX - wrapperBounds.left - 90,
        y: event.clientY - wrapperBounds.top - 30,
      }

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

  return (
    <div className="app">
      <Sidebar onExport={onExport} />
      <div className="canvas" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          edgesReconnectable
          fitView
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a4a" />
          <Controls />
          <MiniMap
            nodeColor={(n) => {
              if (n.type === 'orchestrator') return '#4caf50'
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
    </div>
  )
}
