/**
 * Studio view model. Pure functions that map the core graph to React Flow
 * and fold run messages (live) or a saved Performance (replay) into frames
 * the canvas, inspector and timeline render.
 */
import type { Edge, Node } from '@xyflow/react'
import { graphToPattern, readsOf, writesOf, type VisualGraph } from '@core/graph'
import { EMPTY_FRAME, framesOf, reduceFrame, type Frame, type NodeStatus } from '@core/replay'
import type { NodeKind, Pause, Performance, Role, SavedRun, ScoreEdge, ScoreNode, StateField } from '@core/types'
import type { PatternData, RunMessage } from './api'

// ── canvas ──────────────────────────────────────────────────────────

export type FlowNodeData = {
  node: ScoreNode
  reads: string[]
  writes: string[]
  status?: NodeStatus
  visits?: number
  breakpoint?: boolean
  issues?: string[]
  gate?: 'before' | 'after'
  onToggleBreakpoint?: (id: string) => void
}
export type FlowNode = Node<FlowNodeData>

export type FlowEdgeData = {
  edge: ScoreEdge
  carries: string[]
  back: boolean
  count?: number
  active?: boolean
  values?: Readonly<Record<string, unknown>>
  issues?: string[]
}
export type FlowEdge = Edge<FlowEdgeData>

export interface PatternMeta {
  name: string
  description: string
  requiredContext: string[]
  verbTriggers: string[]
  state: StateField[]
  maxSteps?: number
}

export function metaOf(p: PatternData): PatternMeta {
  return {
    name: p.name,
    description: p.description,
    requiredContext: [...p.requiredContext],
    verbTriggers: [...(p.verbTriggers ?? [])],
    state: [...p.state],
    ...(p.maxSteps ? { maxSteps: p.maxSteps } : {}),
  }
}

export function toFlow(graph: VisualGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { ...n.position },
      data: { node: n.data.node, reads: [...n.data.reads], writes: [...n.data.writes] },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      type: 'data',
      data: { edge: e.data.edge, carries: [...e.data.carries], back: e.data.back },
    })),
  }
}

export function fromFlow(meta: PatternMeta, nodes: readonly FlowNode[], edges: readonly FlowEdge[]): PatternData {
  const g = graphToPattern(
    {
      nodes: nodes.map((n) => ({ id: n.id, data: { node: n.data.node } })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        ...(e.data ? { data: { edge: e.data.edge } } : {}),
      })),
    },
    { state: meta.state, ...(meta.maxSteps ? { maxSteps: meta.maxSteps } : {}) },
  )
  return {
    name: meta.name,
    description: meta.description,
    requiredContext: meta.requiredContext,
    verbTriggers: meta.verbTriggers,
    ...g,
  }
}

/** Replace a node's definition and refresh its derived reads/writes. */
export function withNode(n: FlowNode, node: ScoreNode, state: readonly StateField[]): FlowNode {
  return {
    ...n,
    data: {
      ...n.data,
      node,
      reads: readsOf(node),
      writes: writesOf(node, { state, nodes: [], edges: [], start: '' }),
    },
  }
}

export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  for (let i = 1; ; i += 1) {
    const id = `${prefix}${i}`
    if (!set.has(id)) return id
  }
}

export type PaletteKind = 'start' | 'assessor' | 'executor' | 'compute' | 'condition' | 'approval' | 'end'

export function newNode(kind: PaletteKind, id: string, position: { x: number; y: number }): FlowNode {
  const node: ScoreNode = (() => {
    switch (kind) {
      case 'assessor':
      case 'executor':
        return {
          id,
          kind: 'agent',
          role: kind as Role,
          label: kind === 'assessor' ? 'Assess' : 'Execute',
          directive: kind === 'assessor' ? 'Read the workspace and report.' : 'Make the change.',
          reads: [],
          writes: [],
        }
      case 'compute':
        return { id, kind: 'compute', label: 'Compute', assign: [] }
      case 'condition':
        return { id, kind: 'condition', label: 'If', expression: 'true' }
      case 'approval':
        return { id, kind: 'approval', label: 'Approve', message: 'Approve?', writes: [] }
      case 'end':
        return { id, kind: 'end', label: 'End' }
      default:
        return { id, kind: 'start', label: 'Start' }
    }
  })()
  return { id, type: node.kind, position, data: { node, reads: readsOf(node), writes: writesOf(node) } }
}

// ── runs ────────────────────────────────────────────────────────────

export type RunStatus = 'idle' | 'running' | 'paused' | 'awaiting-approval' | 'done' | 'failed' | 'cancelled'

export interface AiStream {
  readonly key: string
  readonly nodeId: string
  readonly step: number
  readonly attempt: number
  text: string
  reasoning: string
  messages: string[]
  tools: { id: string; name: string; ok?: boolean; args?: unknown; denied?: string }[]
  permissions: { kind: string; allowed: boolean; detail: string }[]
  info: string[]
  result?: unknown
  rejected?: readonly string[]
}

export interface RunView {
  readonly mode: 'idle' | 'live' | 'replay'
  readonly runId?: string
  readonly status: RunStatus
  readonly frames: readonly Frame[]
  /** Frame index being shown; null follows the latest frame. */
  readonly cursor: number | null
  readonly pause?: Pause
  readonly gate?: { readonly nodeId: string; readonly phase: 'before' | 'after'; readonly proposed?: unknown }
  readonly streams: readonly AiStream[]
  readonly performance?: Performance
  readonly savedTo?: string
  readonly reason?: string
  readonly replay?: { readonly reproduced: boolean; readonly issues: readonly string[]; readonly file?: string }
}

export const IDLE_VIEW: RunView = { mode: 'idle', status: 'idle', frames: [], cursor: null, streams: [] }

export function startLive(runId: string): RunView {
  return { ...IDLE_VIEW, mode: 'live', runId, status: 'running' }
}

export function currentFrame(v: RunView): Frame {
  if (v.frames.length === 0) return EMPTY_FRAME
  return v.cursor === null ? v.frames.at(-1)! : (v.frames[Math.min(v.cursor, v.frames.length - 1)] ?? EMPTY_FRAME)
}

function updateStream(v: RunView, nodeId: string, attempt: number, fn: (s: AiStream) => void): AiStream[] {
  const step = v.pause?.nodeId === nodeId ? v.pause.step : (v.frames.at(-1)?.step ?? 0)
  const key = `${step}:${nodeId}:${attempt}`
  const streams = [...v.streams]
  let i = streams.findIndex((s) => s.key === key)
  if (i === -1) {
    streams.push({ key, nodeId, step, attempt, text: '', reasoning: '', messages: [], tools: [], permissions: [], info: [] })
    i = streams.length - 1
  }
  const copy: AiStream = { ...streams[i]!, messages: [...streams[i]!.messages], tools: [...streams[i]!.tools], permissions: [...streams[i]!.permissions], info: [...streams[i]!.info] }
  fn(copy)
  streams[i] = copy
  return streams
}

export function applyMessage(v: RunView, m: RunMessage): RunView {
  switch (m.type) {
    case 'engine': {
      const frame = reduceFrame(v.frames.at(-1) ?? EMPTY_FRAME, m.event)
      const e = m.event
      let pause = v.pause
      let streams = v.streams
      if (e.type === 'paused') pause = e.pause
      if (e.type === 'node-completed' || e.type === 'run-completed' || e.type === 'run-failed') pause = undefined
      if (e.type === 'response-rejected' && v.pause?.kind === 'agent') {
        const attempt = v.pause.attempt
        streams = updateStream(v, e.nodeId, attempt, (s) => {
          s.rejected = e.errors
        })
      }
      const { pause: _p, ...rest } = v
      return { ...rest, ...(pause ? { pause } : {}), streams, frames: [...v.frames, frame] }
    }
    case 'provider': {
      const e = m.event
      const streams = updateStream(v, m.nodeId, m.attempt, (s) => {
        switch (e.type) {
          case 'delta':
            s.text += e.text
            break
          case 'reasoning':
            s.reasoning += e.text
            break
          case 'message':
            s.messages.push(e.text)
            break
          case 'tool-start':
            s.tools.push({ id: e.id, name: e.name, args: e.args })
            break
          case 'tool-end': {
            const t = s.tools.find((x) => x.id === e.id)
            if (t) t.ok = e.ok
            break
          }
          case 'permission':
            s.permissions.push({ kind: e.kind, allowed: e.allowed, detail: e.detail })
            break
          case 'info':
            s.info.push(e.text)
            break
        }
      })
      return { ...v, streams }
    }
    case 'status': {
      const { gate: _g, ...rest } = v
      if (m.status === 'paused' && m.nodeId && m.phase) {
        const gate = { nodeId: m.nodeId, phase: m.phase, ...(m.proposed !== undefined ? { proposed: m.proposed } : {}) }
        let streams = v.streams
        if (m.phase === 'after' && v.pause?.kind === 'agent') {
          streams = updateStream(v, m.nodeId, v.pause.attempt, (s) => {
            s.result = m.proposed
          })
        }
        return { ...rest, status: 'paused', gate, streams }
      }
      return { ...rest, status: m.status, ...(m.reason ? { reason: m.reason } : {}) }
    }
    case 'performance':
      return { ...v, performance: m.performance, ...(m.savedTo ? { savedTo: m.savedTo } : {}) }
  }
}

export function replayView(run: SavedRun, check: { reproduced: boolean; issues: readonly string[]; file?: string }): RunView {
  const perf = run.performance
  const frames = framesOf(perf.events)
  const streams: AiStream[] = []
  for (const s of perf.steps) {
    if (s.kind !== 'agent') continue
    const attempts = [...(s.attempts ?? []).map((a) => ({ t: a.transcript, rejected: a.errors, result: undefined as unknown })), { t: s.transcript, rejected: undefined, result: s.verdict ? { updates: s.updates, verdict: s.verdict } : undefined }]
    attempts.forEach((a, i) => {
      if (!a.t && !a.result) return
      streams.push({
        key: `${s.step}:${s.nodeId}:${i + 1}`,
        nodeId: s.nodeId,
        step: s.step,
        attempt: i + 1,
        text: a.t?.output ?? '',
        reasoning: '',
        messages: [],
        tools: (a.t?.toolCalls ?? []).map((c, j) => ({ id: String(j), name: c.name, ...(c.ok !== undefined ? { ok: c.ok } : {}), args: c.args, ...(c.denied ? { denied: c.denied } : {}) })),
        permissions: [],
        info: a.t ? [`${a.t.provider}${a.t.model ? ` · ${a.t.model}` : ''}`] : [],
        ...(a.result ? { result: a.result } : {}),
        ...(a.rejected ? { rejected: a.rejected } : {}),
      })
    })
  }
  const status: RunStatus = perf.outcome === 'failed' ? 'failed' : perf.outcome === 'cancelled' ? 'cancelled' : 'done'
  return {
    mode: 'replay',
    status,
    frames,
    cursor: frames.length > 0 ? frames.length - 1 : null,
    streams,
    performance: perf,
    ...(perf.reason ? { reason: perf.reason } : {}),
    replay: { reproduced: check.reproduced, issues: check.issues, ...(check.file ? { file: check.file } : {}) },
  }
}

/** Latest AI stream for a node at or before the frame's step. */
export function streamFor(v: RunView, nodeId: string, frame: Frame): AiStream | undefined {
  const atOrBefore = v.streams.filter((s) => s.nodeId === nodeId && s.step <= Math.max(frame.step, 1))
  return atOrBefore.at(-1)
}

export function decorate(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  frame: Frame,
  opts: {
    breakpoints: ReadonlySet<string>
    issues: ReadonlyMap<string, string[]>
    gate?: RunView['gate']
    onToggleBreakpoint?: (id: string) => void
  },
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: nodes.map((n) => {
      const status = frame.nodeStatus[n.id]
      const visits = frame.nodeVisits[n.id]
      const issues = opts.issues.get(n.id)
      return {
        ...n,
        data: {
          ...n.data,
          ...(status ? { status } : { status: undefined }),
          ...(visits ? { visits } : { visits: undefined }),
          breakpoint: opts.breakpoints.has(n.id),
          ...(issues ? { issues } : { issues: undefined }),
          ...(opts.gate?.nodeId === n.id ? { gate: opts.gate.phase } : { gate: undefined }),
          ...(opts.onToggleBreakpoint ? { onToggleBreakpoint: opts.onToggleBreakpoint } : {}),
        },
      }
    }),
    edges: edges.map((e) => {
      const active = frame.lastEdge?.id === e.id
      const issues = opts.issues.get(e.id)
      return {
        ...e,
        animated: false,
        data: {
          ...(e.data as FlowEdgeData),
          count: frame.edgeCounts[e.id] ?? 0,
          active,
          ...(active ? { values: frame.lastEdge!.values } : { values: undefined }),
          ...(issues ? { issues } : { issues: undefined }),
        },
      }
    }),
  }
}

export const KIND_LABEL: Record<NodeKind, string> = {
  start: 'Start',
  agent: 'Agent',
  compute: 'Compute',
  condition: 'If',
  approval: 'Approval',
  tool: 'Tool',
  end: 'End',
}
