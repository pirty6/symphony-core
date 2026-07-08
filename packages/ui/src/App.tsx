import { useCallback, useRef, type DragEvent } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  addEdge,
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
import { Sidebar } from './components/Sidebar'
import type { DraggableNodeType } from './types'

const nodeTypes = {
  orchestrator: OrchestratorNode,
  assessor: AssessorNode,
  executor: ExecutorNode,
  end: EndNode,
  condition: ConditionNode,
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
    data: { label: 'Orchestrator', description: 'Entry point — routes to instruments' },
    deletable: false,
  },
]

const initialEdges: Edge[] = []

let nodeId = 1

function getNextId() {
  return `instrument-${++nodeId}`
}

const descriptions: Record<DraggableNodeType, string> = {
  assessor: 'Read-only evidence gatherer',
  executor: 'Write-focused change applier',
  end: 'Terminal point of a path',
  condition: 'Conditional branch (then/else)',
}

export default function App() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  )

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()

      const type = event.dataTransfer.getData('application/reactflow') as DraggableNodeType
      if (!type) return

      const wrapperBounds = reactFlowWrapper.current?.getBoundingClientRect()
      if (!wrapperBounds) return

      const position = {
        x: event.clientX - wrapperBounds.left - 90,
        y: event.clientY - wrapperBounds.top - 30,
      }

      const labels: Record<DraggableNodeType, string> = {
        assessor: 'Assessor',
        executor: 'Executor',
        end: 'End',
        condition: 'If',
      }

      const newNode: Node = {
        id: getNextId(),
        type,
        position,
        data: {
          label: labels[type],
          description: descriptions[type],
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
        label: (n.data as { label: string }).label,
        description: (n.data as { description: string }).description,
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
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
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
              return '#666'
            }}
          />
        </ReactFlow>
      </div>
    </div>
  )
}
