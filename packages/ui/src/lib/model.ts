/**
 * Studio view model. Pure functions that map the core graph to React Flow
 * and fold run messages (live) or a saved Performance (replay) into frames
 * the canvas, inspector and timeline render.
 */
import type { Edge, Node } from '@xyflow/react'
import { originOf, type Origin, type StepOrigin } from '@core/compare'
import { graphToPattern, groupFrames, phaseView, readsOf, writesOf, type VisualGraph } from '@core/graph'
import { EMPTY_FRAME, framesOf, reduceFrame, type Frame, type NodeStatus } from '@core/replay'
import type { AiTranscript, ExecutableScore, NodeKind, Pause, Performance, Role, SavedRun, ScoreEdge, ScoreGroup, ScoreNode, StateField } from '@core/types'
import type { NextPerformance, PatternData, RunMessage } from './api'

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
  /** Who played this node's latest step in a finished run. */
  origin?: StepOrigin
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
  /** Required input whose value is the run's goal. */
  goalFrom?: string
  /** State keys the run delivers. */
  result?: string[]
  /** Phases: named groups of steps the canvas can collapse. */
  groups?: ScoreGroup[]
}

export function metaOf(p: PatternData): PatternMeta {
  return {
    name: p.name,
    description: p.description,
    requiredContext: [...p.requiredContext],
    verbTriggers: [...(p.verbTriggers ?? [])],
    state: [...p.state],
    ...(p.maxSteps ? { maxSteps: p.maxSteps } : {}),
    ...(p.goalFrom ? { goalFrom: p.goalFrom } : {}),
    ...(p.result?.length ? { result: [...p.result] } : {}),
    ...(p.groups?.length ? { groups: p.groups.map((g) => ({ ...g, nodes: [...g.nodes] })) } : {}),
  }
}

/** What the studio shows for a run's score (saved or live): enough to draw and label it. */
export function scoreMeta(score: ExecutableScore): PatternMeta {
  return {
    name: score.pattern,
    description: score.description,
    requiredContext: [],
    verbTriggers: [],
    state: [...score.state],
    maxSteps: score.maxSteps,
    ...(score.groups?.length ? { groups: score.groups.map((g) => ({ ...g, nodes: [...g.nodes] })) } : {}),
    ...(score.result?.length ? { result: [...score.result] } : {}),
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
  // Keep phases in step with the canvas: deleted steps leave their phase, empty phases go.
  const ids = new Set(nodes.map((n) => n.id))
  const groups = (meta.groups ?? []).map((gr) => ({ ...gr, nodes: gr.nodes.filter((id) => ids.has(id)) })).filter((gr) => gr.nodes.length > 0)
  return {
    name: meta.name,
    description: meta.description,
    requiredContext: meta.requiredContext,
    verbTriggers: meta.verbTriggers,
    ...(meta.goalFrom ? { goalFrom: meta.goalFrom } : {}),
    ...(meta.result?.length ? { result: meta.result } : {}),
    ...g,
    ...(groups.length > 0 ? { groups } : {}),
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

export type PaletteKind = 'start' | 'assessor' | 'executor' | 'compute' | 'tool' | 'condition' | 'approval' | 'end'

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
      case 'tool':
        return { id, kind: 'tool', label: 'List files', tool: 'repo.files', output: {} }
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
  /** Jazz: 1..N for a take, 0 for the bandleader's merge. */
  readonly take?: number
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
  /** The goal of the score being performed. */
  readonly goal?: string
  /** State keys the score declares as its result. */
  readonly resultKeys?: readonly string[]
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
  /** reproduced: undefined while the replay is still being checked. */
  readonly replay?: { readonly reproduced?: boolean; readonly issues: readonly string[]; readonly file?: string }
  /** The maestro handed on a composed score. */
  readonly next?: NextPerformance
}

export const IDLE_VIEW: RunView = { mode: 'idle', status: 'idle', frames: [], cursor: null, streams: [] }

export function startLive(runId: string, goal?: string, resultKeys?: readonly string[]): RunView {
  return {
    ...IDLE_VIEW,
    mode: 'live',
    runId,
    status: 'running',
    ...(goal ? { goal } : {}),
    ...(resultKeys?.length ? { resultKeys } : {}),
  }
}

export function currentFrame(v: RunView): Frame {
  if (v.frames.length === 0) return EMPTY_FRAME
  return v.cursor === null ? v.frames.at(-1)! : (v.frames[Math.min(v.cursor, v.frames.length - 1)] ?? EMPTY_FRAME)
}

function updateStream(
  v: RunView,
  nodeId: string,
  attempt: number,
  fn: (s: AiStream) => void,
  take?: number,
): AiStream[] {
  const step = v.pause?.nodeId === nodeId ? v.pause.step : (v.frames.at(-1)?.step ?? 0)
  const key = `${step}:${nodeId}:${attempt}${take !== undefined ? `:${take}` : ''}`
  const streams = [...v.streams]
  let i = streams.findIndex((s) => s.key === key)
  if (i === -1) {
    streams.push({ key, nodeId, step, attempt, ...(take !== undefined ? { take } : {}), text: '', reasoning: '', messages: [], tools: [], permissions: [], info: [] })
    i = streams.length - 1
  }
  const copy: AiStream = { ...streams[i]!, messages: [...streams[i]!.messages], tools: [...streams[i]!.tools], permissions: [...streams[i]!.permissions], info: [...streams[i]!.info] }
  fn(copy)
  streams[i] = copy
  return streams
}

/**
 * End the run on screen when the server can no longer tell us about it (it
 * restarted and lost the run, or cannot be reached to stop it): no gate or
 * approval stays waiting for an answer nobody can receive.
 */
export function endLocally(v: RunView, reason: string): RunView {
  const { gate: _g, pause: _p, ...rest } = v
  return { ...rest, status: 'cancelled', reason }
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
      const streams = updateStream(
        v,
        m.nodeId,
        m.attempt,
        (s) => {
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
      },
        m.take,
      )
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
    case 'next':
      return { ...v, next: m }
  }
}

/** Who played a recorded answer: tier, requested model, account, SDK and sampling. */
export function musicianLines(t: AiTranscript): string[] {
  const m = t.musician
  if (!m) return []
  const asked = m.requestedModel ? `asked for ${m.requestedModel}${m.effort ? ` (${m.effort})` : ''}` : 'default model'
  return [[`tier ${m.tier}`, asked, m.account, m.sdk].filter(Boolean).join(' · '), `sampling: ${m.sampling}`]
}

export function replayView(run: SavedRun, check: { reproduced?: boolean | undefined; issues: readonly string[]; file?: string }): RunView {
  const perf = run.performance
  const frames = framesOf(perf.events)
  const streams: AiStream[] = []
  for (const s of perf.steps) {
    if (s.kind !== 'agent') continue
    const attempts = [...(s.attempts ?? []).map((a) => ({ t: a.transcript, rejected: a.errors, result: undefined as unknown })), { t: s.transcript, rejected: undefined, result: s.verdict ? { updates: s.updates, verdict: s.verdict } : undefined }]
    attempts.forEach((a, i) => {
      if (!a.t && !a.result) return
      ;(a.t?.takes ?? []).forEach((t, k) =>
        streams.push({
          key: `${s.step}:${s.nodeId}:${i + 1}:${k + 1}`,
          nodeId: s.nodeId,
          step: s.step,
          attempt: i + 1,
          take: k + 1,
          text: t.output,
          reasoning: '',
          messages: [],
          tools: t.toolCalls.map((c, j) => ({ id: String(j), name: c.name, ...(c.ok !== undefined ? { ok: c.ok } : {}), args: c.args })),
          permissions: [],
          info: [`take ${k + 1} · ${t.provider}${t.model ? ` · ${t.model}` : ''}`, ...musicianLines(t)],
        }),
      )
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
        ...(a.t?.takes?.length ? { take: 0 } : {}),
        info: a.t
          ? [`${a.t.fromRepertoire ? `🎼 replayed from ${a.t.fromRepertoire} · ` : ''}${a.t.provider}${a.t.model ? ` · ${a.t.model}` : ''}`, ...musicianLines(a.t)]
          : [],
        ...(a.result ? { result: a.result } : {}),
        ...(a.rejected ? { rejected: a.rejected } : {}),
      })
    })
  }
  const status: RunStatus =
    perf.outcome === 'failed' ? 'failed' : perf.outcome === 'cancelled' || perf.outcome === 'in-progress' ? 'cancelled' : 'done'
  return {
    mode: 'replay',
    goal: run.score.goal,
    ...(run.score.result?.length ? { resultKeys: run.score.result } : {}),
    status,
    frames,
    cursor: frames.length > 0 ? frames.length - 1 : null,
    streams,
    performance: perf,
    ...(perf.reason ? { reason: perf.reason } : {}),
    replay: {
      ...(check.reproduced !== undefined ? { reproduced: check.reproduced } : {}),
      issues: check.issues,
      ...(check.file ? { file: check.file } : {}),
    },
  }
}

/** Latest AI stream for a node at or before the frame's step. */
export function streamFor(v: RunView, nodeId: string, frame: Frame): AiStream | undefined {
  return streamsFor(v, nodeId, frame).at(-1)
}

/** Every stream of the node's latest attempt at or before the frame: the takes, then the merge. */
export function streamsFor(v: RunView, nodeId: string, frame: Frame): AiStream[] {
  const atOrBefore = v.streams.filter((s) => s.nodeId === nodeId && s.step <= Math.max(frame.step, 1))
  const last = atOrBefore.at(-1)
  if (!last) return []
  return atOrBefore
    .filter((s) => s.step === last.step && s.attempt === last.attempt)
    .toSorted((a, b) => (a.take === 0 ? 99 : (a.take ?? 0)) - (b.take === 0 ? 99 : (b.take ?? 0)))
}

export function decorate(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  frame: Frame,
  opts: {
    breakpoints: ReadonlySet<string>
    issues: ReadonlyMap<string, string[]>
    gate?: RunView['gate']
    origins?: ReadonlyMap<string, StepOrigin>
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
          origin: opts.origins?.get(n.id),
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

// ── result ──────────────────────────────────────────────────────────

export interface RunResult {
  /** Keys the run delivered: the score's declared result, else the last data carried toward its end. */
  readonly keys: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
}

/** What a finished run produced, read from its final frames. Undefined while it runs. */
export function runResult(v: RunView): RunResult | undefined {
  const last = v.frames.at(-1)
  if (!last?.outcome) return undefined
  const final = v.performance?.finalState ?? last.state
  let keys: readonly string[] = v.resultKeys ?? []
  for (let i = v.frames.length - 1; i >= 0 && keys.length === 0; i--) {
    const f = v.frames[i]!
    if (f.event?.type === 'edge-taken' && f.event.carried.length > 0) {
      keys = f.event.carried
      break
    }
  }
  return { keys, values: Object.fromEntries(keys.map((k) => [k, final[k]])) }
}

/** The result as Markdown, for copying and downloading. */
export function resultMarkdown(r: RunResult, title: string): string {
  const body = r.keys.map((k) => {
    const v = r.values[k]
    const text =
      typeof v === 'string'
        ? v
        : Array.isArray(v) && v.every((x) => typeof x === 'string')
          ? v.length > 0
            ? v.map((x) => `- ${x}`).join('\n')
            : '_none_'
          : '```json\n' + JSON.stringify(v, null, 2) + '\n```'
    return `## ${k}\n\n${text}`
  })
  return [`# ${title}`, ...body].join('\n\n') + '\n'
}

// ── origins ─────────────────────────────────────────────────────────

/** Who played each node's latest step, up to a step number. */
export function originsByNode(perf: Performance | undefined, upToStep = Infinity): Map<string, StepOrigin> {
  const out = new Map<string, StepOrigin>()
  for (const s of perf?.steps ?? []) if (s.step <= upToStep) out.set(s.nodeId, originOf(s))
  return out
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  live: '🎷 live AI',
  repertoire: '🎼 recorded answer',
  script: '📜 scripted',
  tool: '⚙ tool',
  human: '✋ human',
  engine: '♩ engine',
}

/** e.g. "12 live AI · 4 tool · 1 human · 30 engine · 3 AI steps with takes merged" */
export function originSummary(perf: Performance): string {
  const counts = new Map<Origin, number>()
  let takes = 0
  for (const s of perf.steps) {
    const o = originOf(s)
    counts.set(o.origin, (counts.get(o.origin) ?? 0) + 1)
    if (s.transcript?.takes?.length) takes++
  }
  const order: Origin[] = ['live', 'repertoire', 'script', 'tool', 'human', 'engine']
  const parts = order.filter((o) => counts.has(o)).map((o) => `${counts.get(o)} ${ORIGIN_LABEL[o].replace(/^\S+ /, '')}`)
  return [...parts, ...(takes ? [`${takes} AI steps with takes merged`] : [])].join(' · ')
}

// ── settings and the offline demo ─────────────────────────────────────

export interface StoredSettings {
  provider: 'scripted' | 'copilot'
  model: string
  /** Optional patterns shown in the library (unset: as the server's SYMPHONY_EXTRAS says). */
  extras: boolean
}

/** The AI choice kept between visits, so a reload never silently switches to the offline demo. */
export function parseStoredSettings(raw: string | null): Partial<StoredSettings> {
  try {
    const v = JSON.parse(raw ?? '{}') as Record<string, unknown>
    return {
      ...(v.provider === 'scripted' || v.provider === 'copilot' ? { provider: v.provider } : {}),
      ...(typeof v.model === 'string' ? { model: v.model } : {}),
      ...(typeof v.extras === 'boolean' ? { extras: v.extras } : {}),
    }
  } catch {
    return {}
  }
}

/** True when every AI step was a canned demo answer (played now, or replayed from an earlier demo run). */
export function isOfflineDemo(perf: Performance | undefined): boolean {
  const ai = (perf?.steps ?? []).filter((s) => s.kind === 'agent')
  return ai.length > 0 && ai.every((s) => s.transcript?.provider === 'scripted')
}

/** Inputs the user typed that the demo's canned answers were not written for. */
export function changedFromDemo(context: Readonly<Record<string, string>>, demo: Readonly<Record<string, string>>): string[] {
  // Only what you typed counts: an empty field plays the demo's value.
  return Object.keys(demo).filter((k) => {
    const mine = (context[k] ?? '').trim()
    return mine !== '' && mine !== (demo[k] ?? '').trim()
  })
}

// ── phases ──────────────────────────────────────────────────────────

export type PhaseNodeData = {
  group: ScoreGroup
  steps: string[]
  writes: string[]
  status?: NodeStatus
  current?: string
  ran: number
  onExpand?: (id: string) => void
}
export type FrameNodeData = { label: string; width: number; height: number; onCollapse?: (id: string) => void }
export type CanvasNode = FlowNode | Node<PhaseNodeData, 'phase'> | Node<FrameNodeData, 'frame'>

const STATUS_RANK: Record<NodeStatus, number> = { paused: 4, active: 3, failed: 2, done: 1 }

/**
 * What the canvas draws when the pattern has phases: collapsed phases become
 * one node each (status = the most urgent of its steps), opened phases are
 * boxed by a frame behind their steps. Without phases the input passes through.
 */
export function phaseDisplay(
  pattern: PatternData,
  decorated: { nodes: readonly FlowNode[]; edges: readonly FlowEdge[] },
  expanded: ReadonlySet<string>,
  frame: Frame,
  handlers: { onExpand?: (id: string) => void; onCollapse?: (id: string) => void } = {},
): { nodes: CanvasNode[]; edges: FlowEdge[]; phaseOf: Map<string, string>; collapsed: boolean } {
  const groups = pattern.groups ?? []
  const phaseOf = new Map<string, string>()
  if (groups.length === 0) return { nodes: [...decorated.nodes], edges: [...decorated.edges], phaseOf, collapsed: false }

  const anyCollapsed = groups.some((g) => !expanded.has(g.id))
  const byId = new Map(decorated.nodes.map((n) => [n.id, n]))
  const edgeById = new Map(decorated.edges.map((e) => [e.id, e]))
  const view = anyCollapsed ? phaseView(pattern, expanded) : undefined
  const positions = new Map(view ? view.nodes.map((n) => [n.id, n.position]) : decorated.nodes.map((n) => [n.id, n.position]))

  const frames: CanvasNode[] = groupFrames(
    pattern,
    positions,
    groups.filter((g) => expanded.has(g.id)),
  ).map((f) => ({
    id: `frame:${f.id}`,
    type: 'frame',
    position: { x: f.x, y: f.y },
    data: { label: f.label, width: f.width, height: f.height, ...(handlers.onCollapse ? { onCollapse: handlers.onCollapse } : {}) },
    draggable: false,
    selectable: false,
    connectable: false,
    zIndex: -1,
    style: { width: f.width, height: f.height },
  }))
  if (!view) return { nodes: [...frames, ...decorated.nodes], edges: [...decorated.edges], phaseOf, collapsed: false }

  const nodes: CanvasNode[] = view.nodes.flatMap((v): CanvasNode[] => {
    if (v.kind === 'node') {
      const n = byId.get(v.id)
      return n ? [{ ...n, position: { ...v.position }, draggable: false }] : []
    }
    const g = v.group!
    for (const id of g.nodes) phaseOf.set(id, g.id)
    const members = g.nodes.flatMap((id) => {
      const n = byId.get(id)
      return n ? [n] : []
    })
    let status: NodeStatus | undefined
    let current: string | undefined
    for (const m of members) {
      const s = frame.nodeStatus[m.id]
      if (s && (!status || STATUS_RANK[s] > STATUS_RANK[status])) status = s
      if (s === 'active' || s === 'paused') current = m.data.node.label
    }
    const writes = [...new Set(members.flatMap((m) => m.data.writes))]
    const data: PhaseNodeData = {
      group: g,
      steps: members.map((m) => m.data.node.label),
      writes,
      ran: members.reduce((sum, m) => sum + (frame.nodeVisits[m.id] ?? 0), 0),
      ...(status ? { status } : {}),
      ...(current ? { current } : {}),
      ...(handlers.onExpand ? { onExpand: handlers.onExpand } : {}),
    }
    return [{ id: g.id, type: 'phase', position: { ...v.position }, data, draggable: false }]
  })

  const edges: FlowEdge[] = view.edges.map((v) => {
    const original = v.members.map((id) => edgeById.get(id)).filter((e): e is FlowEdge => e !== undefined)
    const first = original[0]
    if (original.length === 1 && first && first.source === v.source && first.target === v.target) return first
    const active = original.find((e) => e.data?.active)
    const edge: ScoreEdge = { id: v.id, from: v.source, to: v.target, ...(v.label ? { label: v.label } : {}) }
    return {
      id: v.id,
      source: v.source,
      target: v.target,
      sourceHandle: v.sourceHandle ?? null,
      type: 'data',
      data: {
        edge,
        carries: [...new Set(original.flatMap((e) => e.data?.carries ?? []))],
        back: v.back,
        count: original.reduce((sum, e) => sum + (e.data?.count ?? 0), 0),
        active: active !== undefined,
        ...(active?.data?.values ? { values: active.data.values } : {}),
      },
    }
  })
  return { nodes: [...frames, ...nodes], edges, phaseOf, collapsed: true }
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

// ── minimap ──────────────────────────────────────────────────────────

/** Minimap colours per node status, the same as the diagram's (studio.css --active, --approval…). */
const MINIMAP: Record<NodeStatus | 'idle', { readonly fill: string; readonly stroke: string }> = {
  idle: { fill: '#2a3156', stroke: '#2a3156' },
  done: { fill: '#1f4d33', stroke: '#2f6b45' },
  active: { fill: '#fbbf24', stroke: '#fde68a' },
  paused: { fill: '#34d399', stroke: '#a7f3d0' },
  failed: { fill: '#ef4444', stroke: '#fca5a5' },
}

/** How a node shows on the minimap: where the run is lights up as it does on the diagram. */
export function minimapStyle(status: NodeStatus | undefined): { fill: string; stroke: string; className: string } {
  const colours = MINIMAP[status ?? 'idle']
  return { ...colours, className: status ? `minimap-${status}` : '' }
}
