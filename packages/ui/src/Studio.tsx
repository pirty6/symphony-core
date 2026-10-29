import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type DefaultEdgeOptions,
  type NodeChange,
} from '@xyflow/react'
import { patternToGraph, writesOf } from '@core/graph'
import { formatFieldInput, parseFieldInput } from '@core/schema'
import type { Branch, ScoreEdge, ScoreNode } from '@core/types'
import { validatePattern } from '@core/validate'
import { formatUsage, performanceUsage } from '@core/usage'
import { describeEdits } from '@core/edits'
import { DataEdge } from './canvas/DataEdge'
import { FlowNode } from './canvas/FlowNode'
import { FrameNode, PhaseNode } from './canvas/PhaseNode'
import { ApiError, api, subscribeRun, type LibraryItem, type LiveRun, type SavedSummary, type StartRunRequest } from './lib/api'
import {
  IDLE_VIEW,
  applyMessage,
  currentFrame,
  decorate,
  fromFlow,
  metaOf,
  scoreMeta,
  changedFromDemo,
  isOfflineDemo,
  newNode,
  parseStoredSettings,
  originSummary,
  originsByNode,
  phaseDisplay,
  resultMarkdown,
  runResult,
  replayView,
  startLive,
  streamsFor,
  toFlow,
  uniqueId,
  withNode,
  type FlowEdge,
  type FlowNode as FlowNodeType,
  type PaletteKind,
  type PatternMeta,
  type RunView,
} from './lib/model'
import { AiTakes, ApprovalCard, RecoveryCard, EdgeEditor, GateCard, NodeEditor, NodeInput, StateView } from './panels/Inspector'
import { Library } from './panels/Library'
import { ResultPreview, ResultReader } from './panels/Result'
import { PatternPanel } from './panels/PatternPanel'
import { Timeline } from './panels/Timeline'
import { Toolbar, type RunSettings, type Tiers } from './panels/Toolbar'

const nodeTypes = { start: FlowNode, agent: FlowNode, compute: FlowNode, condition: FlowNode, approval: FlowNode, tool: FlowNode, end: FlowNode, phase: PhaseNode, frame: FrameNode }
const edgeTypes = { data: DataEdge }
const defaultEdgeOptions: DefaultEdgeOptions = { type: 'data', markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 } }
const BLANK: PatternMeta = { name: 'my-flow', description: 'A new flow', requiredContext: [], verbTriggers: [], state: [] }
const ACTIVE = new Set(['running', 'paused', 'awaiting-approval'])
const READABLE_ZOOM = 0.55
const SETTINGS_KEY = 'symphony.settings'
/** Results longer than this (characters of Markdown) open in the reader when a live run ends. */
const LONG_RESULT = 600
type Tab = 'node' | 'ai' | 'state'

function contextStrings(ctx: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(ctx ?? {}).map(([k, v]) => [k, formatFieldInput(v)]))
}

export default function Studio() {
  const { screenToFlowPosition, fitView, getZoom, setCenter, getNode } = useReactFlow()
  const [follow, setFollow] = useState(true)
  /** Phases opened on the canvas; the rest are drawn as one node each. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** Measured sizes of phase and frame nodes (they are not in the editable node list). */
  const [phaseSizes, setPhaseSizes] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map())
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [saved, setSaved] = useState<SavedSummary[]>([])
  const [live, setLive] = useState<LiveRun[]>([])
  const [meta, setMeta] = useState<PatternMeta>(BLANK)
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeType>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([])
  const [goal, setGoal] = useState('')
  const [context, setContext] = useState<Record<string, string>>({})
  const [settings, setSettings] = useState<RunSettings>(() => ({
    provider: 'scripted',
    model: '',
    ...parseStoredSettings(localStorage.getItem(SETTINGS_KEY)),
    autoApprove: false,
    stepMode: false,
    complexity: 0,
    improvisation: 0,
  }))
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ provider: settings.provider, model: settings.model }))
  }, [settings.provider, settings.model])
  // Choosing Copilot on a machine with no GitHub account signed in: say how to fix it before a run fails.
  useEffect(() => {
    if (settings.provider !== 'copilot') return
    let cancelled = false
    void api.copilotStatus().then(
      (s) => !cancelled && !s.signedIn && setError(s.message),
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [settings.provider])
  const [tiers, setTiers] = useState<Tiers | undefined>()
  const [notice, setNotice] = useState<string | null>(null)
  /** The full-screen result reader is open. */
  const [reading, setReading] = useState(false)
  /** Pattern to play after this one with its result ('' = none). */
  const [thenPattern, setThenPattern] = useState('')
  const [breakpoints, setBreakpoints] = useState<Set<string>>(new Set())
  const [view, setView] = useState<RunView>(IDLE_VIEW)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('node')
  const [error, setError] = useState<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)

  const editable = view.mode === 'idle'
  const runActive = view.mode === 'live' && ACTIVE.has(view.status)

  // ── loading ────────────────────────────────────────────────────────

  const showGraph = useCallback(
    (m: PatternMeta, graph: LibraryItem['graph']) => {
      const flow = toFlow(graph)
      setMeta(m)
      setNodes(flow.nodes)
      setEdges(flow.edges)
      setExpanded(new Set())
      setSelected(null)
      setTimeout(() => {
        void fitView({ padding: 0.15 }).then(() => {
          // Big flows become unreadable when fitted: start at the top, readable size.
          const start = flow.nodes.find((n) => n.type === 'start')
          if (getZoom() < READABLE_ZOOM && start) {
            void setCenter(start.position.x + 115, start.position.y + 320, { zoom: 0.8, duration: 300 })
          }
        })
      }, 50)
    },
    [fitView, getZoom, setCenter, setEdges, setNodes],
  )

  const loadPattern = useCallback(
    (item: LibraryItem) => {
      unsubscribe.current?.()
      showGraph(metaOf(item), item.graph)
      setGoal(item.demo?.goal ?? item.description)
      setThenPattern('')
      setContext(contextStrings(item.demo?.context))
      setBreakpoints(new Set())
      setView(IDLE_VIEW)
      setTab('node')
      setError(null)
      history.replaceState(null, '', `#${item.name}`)
    },
    [showGraph],
  )

  const refreshSaved = useCallback(() => void api.saved().then(setSaved, () => setSaved([])), [])
  // Several runs can play at once on this server; poll so the list stays current.
  useEffect(() => {
    const poll = () => void api.liveRuns().then(setLive, () => undefined)
    poll()
    const timer = setInterval(poll, 2000)
    return () => clearInterval(timer)
  }, [])

  // Load the library and the pattern named in the URL once; later loads are user actions.
  const loadPatternRef = useRef(loadPattern)
  loadPatternRef.current = loadPattern
  useEffect(() => {
    let cancelled = false
    api.patterns().then(
      (items) => {
        if (cancelled) return
        setLibrary(items)
        const wanted = decodeURIComponent(location.hash.slice(1)) || 'hangman'
        const first = items.find((i) => i.name === wanted) ?? items[0]
        if (first) loadPatternRef.current(first)
      },
      (e: Error) => !cancelled && setError(`Could not load patterns: ${e.message}`),
    )
    refreshSaved()
    api.tiers().then(
      (t) => !cancelled && setTiers(t),
      () => undefined,
    )
    return () => {
      cancelled = true
      unsubscribe.current?.()
    }
  }, [refreshSaved])

  useEffect(() => {
    if (view.mode === 'live' && !ACTIVE.has(view.status)) refreshSaved()
  }, [view.mode, view.status, refreshSaved])

  // ── derived ────────────────────────────────────────────────────────

  const pattern = useMemo(() => fromFlow(meta, nodes, edges), [meta, nodes, edges])
  const report = useMemo(() => validatePattern(pattern), [pattern])
  const issues = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const i of [...report.errors, ...report.warnings]) {
      const key = i.nodeId ?? i.edgeId
      if (key) map.set(key, [...(map.get(key) ?? []), i.message])
    }
    return map
  }, [report])

  const frame = currentFrame(view)

  const toggleBreakpoint = useCallback(
    (id: string) => {
      setBreakpoints((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        if (view.runId && view.mode === 'live') void api.control(view.runId, 'breakpoints', { breakpoints: [...next] })
        return next
      })
    },
    [view.runId, view.mode],
  )

  const openPhase = useCallback((id: string) => setExpanded((prev) => new Set(prev).add(id)), [])
  const closePhase = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      }),
    [],
  )
  const phaseIds = useMemo(() => (meta.groups ?? []).map((g) => g.id), [meta.groups])
  const allOpen = phaseIds.length > 0 && phaseIds.every((id) => expanded.has(id))
  const togglePhases = useCallback(() => {
    setExpanded(allOpen ? new Set() : new Set(phaseIds))
    setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 50)
  }, [allOpen, phaseIds, fitView])

  const origins = useMemo(() => originsByNode(view.performance, frame.step), [view.performance, frame.step])

  const display = useMemo(() => {
    const d = decorate(nodes, edges, frame, {
      breakpoints,
      issues: editable ? issues : new Map(),
      ...(view.gate ? { gate: view.gate } : {}),
      origins,
      onToggleBreakpoint: toggleBreakpoint,
    })
    const writes = new Map(nodes.map((n) => [n.id, writesOf(n.data.node, { state: meta.state, nodes: [], edges: [], start: '' })]))
    const steps = { nodes: d.nodes, edges: d.edges.map((e) => ({ ...e, data: { ...e.data!, carries: writes.get(e.source) ?? [] } })) }
    const shown = phaseDisplay(pattern, steps, expanded, frame, { onExpand: openPhase, onCollapse: closePhase })
    const sized = shown.nodes.map((n) => {
      const size = n.type === 'phase' || n.type === 'frame' ? phaseSizes.get(n.id) : undefined
      return size ? { ...n, measured: size } : n
    })
    return { ...shown, nodes: sized }
  }, [nodes, edges, frame, breakpoints, editable, issues, view.gate, origins, toggleBreakpoint, meta.state, pattern, expanded, openPhase, closePhase, phaseSizes])

  const onCanvasNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const steps = new Set(nodes.map((n) => n.id))
      const sizes = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions && !steps.has(c.id) ? [[c.id, c.dimensions] as const] : []))
      if (sizes.length > 0) setPhaseSizes((prev) => new Map([...prev, ...sizes]))
      onNodesChange(changes.filter((c) => !('id' in c) || steps.has(c.id)) as NodeChange<FlowNodeType>[])
    },
    [nodes, onNodesChange],
  )

  const focusId = selected ?? frame.pausedNodeId ?? frame.activeNodeId ?? null
  const selectedNode = nodes.find((n) => n.id === selected)
  const selectedEdge = edges.find((e) => e.id === selected)
  const focusNode = nodes.find((n) => n.id === focusId)
  const streams = focusId ? streamsFor(view, focusId, frame) : []
  const result = useMemo(() => runResult(view), [view])
  const offline = isOfflineDemo(view.performance)
  // The offline demo plays answers written for the demo inputs; warn before it ignores the user's own.
  const demoInputs = useMemo(() => contextStrings(library.find((l) => l.name === meta.name)?.demo?.context), [library, meta.name])
  const ignoredInputs = editable && settings.provider === 'scripted' ? changedFromDemo(context, demoInputs) : []
  const goalText = view.goal ?? ''

  // Open the reader once when a live run finishes with more than the inspector card can show.
  const finished = view.mode === 'live' && result && resultMarkdown(result, '').length > LONG_RESULT ? view.runId : undefined
  useEffect(() => {
    if (finished) setReading(true)
  }, [finished])
  useEffect(() => {
    if (view.mode === 'idle' || ACTIVE.has(view.status)) setReading(false)
  }, [view.mode, view.status])

  const activeStep = view.mode !== 'idle' ? (frame.pausedNodeId ?? frame.activeNodeId) : undefined
  const followId = activeStep ? (display.phaseOf.get(activeStep) ?? activeStep) : undefined
  useEffect(() => {
    if (!follow || !followId) return
    const node = getNode(followId)
    if (!node) return
    void setCenter(node.position.x + 115, node.position.y + 60, { zoom: Math.max(getZoom(), 0.75), duration: 300 })
  }, [follow, followId, getNode, getZoom, setCenter])

  // ── editing ────────────────────────────────────────────────────────

  const onConnect = useCallback(
    (c: Connection) => {
      if (!editable || !c.source || !c.target) return
      setEdges((eds) => {
        const id = uniqueId(`${c.source}-${c.target}-`, eds.map((e) => e.id))
        const branch = (c.sourceHandle ?? undefined) as Branch | undefined
        const edge: ScoreEdge = { id, from: c.source, to: c.target, ...(branch ? { branch } : {}) }
        return addEdge({ ...c, id, type: 'data', data: { edge, carries: [], back: false } }, eds)
      })
    },
    [editable, setEdges],
  )

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      const kind = e.dataTransfer.getData('application/symphony-node') as PaletteKind
      if (!kind || !editable) return
      const prefix = kind === 'assessor' || kind === 'executor' ? kind : kind
      setNodes((ns) => [...ns, newNode(kind, uniqueId(prefix, ns.map((n) => n.id)), screenToFlowPosition({ x: e.clientX, y: e.clientY }))])
    },
    [editable, screenToFlowPosition, setNodes],
  )

  const updateNode = (node: ScoreNode) => setNodes((ns) => ns.map((n) => (n.id === node.id ? withNode(n, node, meta.state) : n)))
  const updateEdge = (edge: ScoreEdge) =>
    setEdges((es) => es.map((e) => (e.id === edge.id ? { ...e, data: { ...e.data!, edge } } : e)))
  const deleteSelected = () => {
    if (!selected) return
    setNodes((ns) => ns.filter((n) => n.id !== selected))
    setEdges((es) => es.filter((e) => e.id !== selected && e.source !== selected && e.target !== selected))
    setSelected(null)
  }

  // ── runs ───────────────────────────────────────────────────────────

  const run = async () => {
    setError(null)
    let ctx: Record<string, unknown>
    try {
      ctx = Object.fromEntries(
        meta.state.filter((f) => (context[f.name] ?? '').trim() !== '').map((f) => [f.name, parseFieldInput(f.type, context[f.name]!)]),
      )
    } catch (e) {
      setError(`Invalid run input: ${(e as Error).message}`)
      return
    }
    await start({ pattern, goal, context: ctx }, breakpoints)
  }

  const followRun = (runId: string, score?: { goal: string; result?: readonly string[] }) => {
    unsubscribe.current?.()
    setView(startLive(runId, score?.goal, score?.result))
    setSelected(null)
    setTab('ai')
    unsubscribe.current = subscribeRun(runId, (m) => setView((v) => (v.runId === runId ? applyMessage(v, m) : v)))
  }

  const start = async (
    what: { pattern: StartRunRequest['pattern']; goal: string; context: Record<string, unknown> },
    bps: ReadonlySet<string>,
  ) => {
    try {
      const { runId, score } = await api.startRun({
        ...what,
        provider: settings.provider,
        ...(settings.model ? { model: settings.model } : {}),
        autoApprove: settings.autoApprove,
        stepMode: settings.stepMode,
        breakpoints: [...bps],
        ...(settings.complexity ? { complexity: settings.complexity } : {}),
        improvisation: settings.improvisation,
        ...(thenPattern && what.pattern.name !== 'maestro' ? { chain: [thenPattern] } : {}),
      })
      followRun(runId, score)
    } catch (e) {
      setError(e instanceof ApiError && e.issues.length ? `${e.message}` : (e as Error).message)
    }
  }

  const ask = async (request: string) => {
    const item = library.find((l) => l.name === 'maestro')
    if (!item) {
      setError('The maestro pattern is not in the library.')
      return
    }
    setError(null)
    setNotice(null)
    loadPattern(item)
    setGoal('Compose the score for the request')
    setContext({ request })
    const { demo: _demo, source: _source, graph: _graph, ...data } = item
    await start({ pattern: data, goal: 'Compose the score for the request', context: { request } }, new Set())
  }

  // The maestro handed on its composed score: show it and follow its performance.
  const metaRef = useRef(meta)
  metaRef.current = meta
  const handedOn = view.next
  useEffect(() => {
    if (!handedOn) return
    const meta = metaOf(handedOn.pattern)
    const from = metaRef.current.name
    if (handedOn.runId) {
      const childId = handedOn.runId
      void api.run(childId).then(
        (r) => {
          showGraph(meta, r.graph)
          setGoal(r.score.goal)
          setContext(contextStrings(r.score.context as Record<string, unknown>))
          setNotice(
            from === 'maestro'
              ? `♪ The maestro composed '${handedOn.pattern.name}' (complexity ${r.score.complexity}). Now performing it.`
              : `♪ ${from} finished. Now playing '${handedOn.pattern.name}' with what it found.`,
          )
          followRun(childId, r.score)
        },
        (e: Error) => setError(e.message),
      )
    } else {
      unsubscribe.current?.()
      showGraph(meta, patternToGraph(handedOn.pattern))
      setContext(contextStrings(handedOn.context as Record<string, unknown>))
      setView(IDLE_VIEW)
      setTab('node')
      setNotice(handedOn.error ?? `The maestro composed '${handedOn.pattern.name}'. Fill in its inputs and press Run.`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react once per hand-off
  }, [handedOn])

  const control = (action: string, extra?: Record<string, unknown>) => {
    if (view.runId) void api.control(view.runId, action, extra).catch((e: Error) => setError(e.message))
  }

  const changeSettings = (s: RunSettings) => {
    if (s.stepMode !== settings.stepMode && runActive) control('stepMode', { on: s.stepMode })
    setSettings(s)
  }

  /** Resume the open saved run, or fork it from a step; the studio follows the new performance. */
  const continueSaved = async (kind: 'resumed' | 'forked', atStep?: number) => {
    const file = view.replay?.file
    if (!file) return
    try {
      const { runId, score } = await api.continueRun({
        file,
        kind,
        ...(atStep !== undefined ? { atStep } : {}),
        provider: settings.provider,
        ...(settings.model ? { model: settings.model } : {}),
        autoApprove: settings.autoApprove,
        stepMode: settings.stepMode,
        breakpoints: [...breakpoints],
      })
      setNotice(
        kind === 'resumed'
          ? `▶ Resuming: recorded steps replayed, the rest played live (${settings.provider}).`
          : `⑂ Forked at step ${atStep}: steps before it kept, the rest played live (${settings.provider}).`,
      )
      followRun(runId, score)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message)
    }
  }

  /** Open a run the server is playing (started here, in another tab, or by a chain). */
  const openLive = async (runId: string) => {
    try {
      const r = await api.run(runId)
      showGraph(scoreMeta(r.score), r.graph)
      setGoal(r.score.goal)
      setContext(contextStrings(r.score.context as Record<string, unknown>))
      setNotice(null)
      followRun(runId, r.score)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const openSaved = async (file: string) => {
    try {
      const res = await api.savedFile(file)
      unsubscribe.current?.()
      showGraph(scoreMeta(res.run.score), res.graph)
      setGoal(res.run.score.goal)
      setContext(contextStrings(res.run.score.context as Record<string, unknown>))
      setView(replayView(res.run, { reproduced: res.reproduced, issues: res.issues, file }))
      setTab('state')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ── render ─────────────────────────────────────────────────────────

  const resultBanner =
    view.mode !== 'idle' && !ACTIVE.has(view.status) && view.status !== 'idle' ? (
      <div className={`card result status-${view.status}`} data-testid="run-result">
        <b>{view.performance?.outcome ?? view.status}</b> {view.reason}
        {view.savedTo && <div className="muted">saved {view.savedTo.split('/.symphony/')[1] ?? view.savedTo}</div>}
        {view.replay && (
          <div className={view.replay.reproduced ? 'ok' : 'issue'} data-testid="replay-check">
            {view.replay.reproduced ? '✓ verified: replaying recorded answers reproduces this run exactly' : `✘ not reproducible ${view.replay.issues.join('; ')}`}
          </div>
        )}
        {offline && (
          <div className="issue" data-testid="offline-result">
            🎭 Offline demo: these are canned answers written for the demo inputs, not an investigation of yours. Choose
            Copilot under AI and run again.
          </div>
        )}
        {view.performance && view.performance.steps.length > 0 && (
          <div className="muted origin-summary" data-testid="origin-summary">
            played by: {originSummary(view.performance)}
            {performanceUsage(view.performance).total.calls > 0 && <> · tokens: {formatUsage(performanceUsage(view.performance).total)}</>}
          </div>
        )}
        {view.performance?.edits && (
          <div className={view.performance.edits.kind === 'patch' ? 'issue' : 'muted'} data-testid="edits-result">
            {describeEdits(view.performance.edits)}
          </div>
        )}
        {view.mode === 'replay' && view.replay?.file && (
          <div className="continue-actions">
            {(view.performance?.outcome === 'in-progress' || view.performance?.outcome === 'cancelled') && (
              <button type="button" className="primary" onClick={() => void continueSaved('resumed')} title={`Continue live with ${settings.provider}`}>
                ▶ Resume
              </button>
            )}
            <button
              type="button"
              onClick={() => void continueSaved('forked', Math.max(1, frame.step))}
              title={`Keep steps before ${Math.max(1, frame.step)}, play the rest again with ${settings.provider}. Scrub the timeline to choose the step.`}
              data-testid="fork"
            >
              ⑂ Fork from step {Math.max(1, frame.step)}
            </button>
          </div>
        )}
        {view.performance?.basedOn && (
          <div className="muted" data-testid="based-on">
            {view.performance.basedOn.kind} from {view.performance.basedOn.from} after step {view.performance.basedOn.throughStep}
          </div>
        )}
        {result && <ResultPreview result={result} onOpen={() => setReading(true)} />}
      </div>
    ) : null

  return (
    <div className="studio">
      {reading && result && result.keys.length > 0 && (
        <ResultReader
          result={result}
          title={`${meta.name}: ${view.performance?.outcome ?? view.status}${offline ? ' · offline demo (canned answers)' : ''}`}
          {...(goalText.trim() ? { subtitle: goalText.trim() } : {})}
          onClose={() => setReading(false)}
        />
      )}
      <Toolbar
        title={meta.name}
        mode={view.mode}
        status={view.status}
        settings={settings}
        canRun={report.errors.length === 0}
        onSettings={changeSettings}
        {...(tiers ? { tiers } : {})}
        onRun={() => void run()}
        onPause={() => control('pause')}
        onResume={() => control('resume')}
        onStep={() => control('step')}
        onStop={() => control('stop')}
        onEdit={() => {
          unsubscribe.current?.()
          setView(IDLE_VIEW)
          setTab('node')
        }}
      />
      <Library
        library={library}
        activeName={meta.name}
        saved={saved}
        editable={editable}
        asking={view.mode === 'live' && ACTIVE.has(view.status) && meta.name === 'maestro'}
        onLoad={loadPattern}
        onNew={() => {
          const start = newNode('start', 'start', { x: 0, y: 0 })
          const end = newNode('end', 'end', { x: 0, y: 200 })
          setMeta(BLANK)
          setNodes([start, end])
          setEdges([{ id: 'start-end', source: 'start', target: 'end', type: 'data', data: { edge: { id: 'start-end', from: 'start', to: 'end' }, carries: [], back: false } }])
          setGoal('')
          setContext({})
          setView(IDLE_VIEW)
        }}
        onOpenSaved={(f) => void openSaved(f)}
        onRefreshSaved={refreshSaved}
        live={live}
        liveId={view.mode === 'live' ? view.runId : undefined}
        onOpenLive={(id) => void openLive(id)}
        onPrune={() =>
          void api
            .prune(true)
            .then(async (plan) => {
              const n = plan.deleted.length + plan.compacted.length + plan.scratch.length
              if (n === 0) return setNotice('Nothing to clean up: demo runs are kept 7 days, real runs 30 days before compacting.')
              const mb = (plan.freed / 1e6).toFixed(1)
              const ok = window.confirm(
                `Delete ${plan.deleted.length} old demo run(s), compact ${plan.compacted.length} old run(s) (they still replay; the AI's raw text is dropped) and clear ${plan.scratch.length} scratch folder(s)? Frees about ${mb} MB.`,
              )
              if (!ok) return
              const done = await api.prune(false)
              setNotice(`Cleaned up ${done.deleted.length + done.compacted.length + done.scratch.length} item(s), ${(done.freed / 1e6).toFixed(1)} MB freed.`)
              refreshSaved()
            })
            .catch((e: Error) => setError(`Clean up failed: ${e.message}`))
        }
        onAsk={(r) => void ask(r)}
      />
      <main className="canvas" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <ReactFlow
          nodes={display.nodes}
          edges={display.edges}
          onNodesChange={onCanvasNodesChange}
          onEdgesChange={editable && !display.collapsed ? onEdgesChange : undefined}
          onConnect={onConnect}
          onNodeClick={(_, n) => {
            if (n.type === 'frame') return
            if (n.type === 'phase') return openPhase(n.id)
            setSelected(n.id)
            setTab(editable ? 'node' : 'ai')
          }}
          onEdgeClick={(_, e) => {
            setSelected(e.id)
            setTab('node')
          }}
          onPaneClick={() => setSelected(null)}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          nodesConnectable={editable && !display.collapsed}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          fitView
          minZoom={0.2}
        >
          {phaseIds.length > 0 && (
            <Panel position="top-left">
              <button type="button" className="phase-switch" onClick={togglePhases} data-testid="toggle-phases">
                {allOpen ? '▣ Close all phases' : '⊕ Open all phases'}
              </button>
            </Panel>
          )}
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2c3354" />
          <Controls />
          <MiniMap pannable zoomable style={{ width: 150, height: 100 }} maskColor="rgba(15, 18, 34, 0.75)" nodeColor="#2a3156" nodeStrokeWidth={2} />
        </ReactFlow>
      </main>
      <aside className="inspector">
        {error && (
          <div className="card issue" role="alert">
            {error}
            <button type="button" className="link" onClick={() => setError(null)} aria-label="dismiss">
              ✕
            </button>
          </div>
        )}
        {ignoredInputs.length > 0 && (
          <div className="card issue" data-testid="demo-warning">
            🎭 <b>Scripted (offline demo)</b> plays canned answers written for the demo inputs, so it will ignore your{' '}
            {ignoredInputs.join(', ')}.
            <button type="button" className="primary" onClick={() => changeSettings({ ...settings, provider: 'copilot' })}>
              Use Copilot
            </button>
          </div>
        )}
        {notice && (
          <div className="card notice" data-testid="notice">
            {notice}
            <button type="button" className="link" onClick={() => setNotice(null)} aria-label="dismiss notice">
              ✕
            </button>
          </div>
        )}
        <GateCard view={view} onResume={() => control('resume')} onStep={() => control('step')} onStop={() => control('stop')} />
        <ApprovalCard view={view} onAnswer={(a) => view.runId && void api.approve(view.runId, a).catch((e: Error) => setError(e.message))} />
        <RecoveryCard view={view} onAnswer={(a) => view.runId && void api.recover(view.runId, a).catch((e: Error) => setError(e.message))} />
        {resultBanner}
        <nav className="tabs">
          {(['node', 'ai', 'state'] as const).map((t) => (
            <button type="button" key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'node' ? (selectedNode || selectedEdge ? 'Selection' : 'Pattern') : t === 'ai' ? 'AI output' : 'State'}
            </button>
          ))}
        </nav>
        <div className="tab-body">
          {tab === 'node' &&
            (selectedNode ? (
              <>
                {editable &&
                  issues.get(selectedNode.id)?.map((m, i) => (
                    <div key={i} className="issue" data-testid="node-issue">
                      {m}
                    </div>
                  ))}
                <NodeEditor node={selectedNode} state={meta.state} editable={editable} onChange={updateNode} onDelete={deleteSelected} />
                {!editable && <NodeInput node={selectedNode} frame={frame} />}
              </>
            ) : selectedEdge ? (
              <>
                {editable &&
                  issues.get(selectedEdge.id)?.map((m, i) => (
                    <div key={i} className="issue">
                      {m}
                    </div>
                  ))}
                <EdgeEditor edge={selectedEdge} editable={editable} onChange={updateEdge} onDelete={deleteSelected} />
              </>
            ) : (
              <PatternPanel
                meta={meta}
                editable={editable}
                goal={goal}
                context={context}
                errors={report.errors}
                warnings={report.warnings}
                onMeta={setMeta}
                onGoal={setGoal}
                onContext={setContext}
                thenOptions={library.map((l) => l.name).filter((n) => n !== meta.name && n !== 'maestro' && n !== 'hangman')}
                then={thenPattern}
                onThen={setThenPattern}
                onSelect={setSelected}
                onExport={() => api.typescript(pattern).then((r) => r.source)}
                onSave={() =>
                  api.savePattern(pattern).then((r) => {
                    void api.patterns().then(setLibrary)
                    return r.file
                  })
                }
              />
            ))}
          {tab === 'ai' && (
            <>
              {focusNode && (
                <h3 className="focus-title">
                  {focusNode.data.node.label} <code>{focusNode.id}</code>
                </h3>
              )}
              {focusNode && <NodeInput node={focusNode} frame={frame} />}
              <AiTakes streams={streams} live={view.cursor === null} />
            </>
          )}
          {tab === 'state' && <StateView frame={frame} />}
        </div>
      </aside>
      <Timeline
        frames={view.frames}
        cursor={view.cursor}
        onSeek={(cursor) => setView((v) => ({ ...v, cursor }))}
        follow={follow}
        onFollow={setFollow}
      />
    </div>
  )
}
