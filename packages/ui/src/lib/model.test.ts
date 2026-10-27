import { describe, expect, it } from 'vitest'
import { compileScore } from '@core/compile'
import { patternToGraph } from '@core/graph'
import { EMPTY_FRAME } from '@core/replay'
import { validateGraph } from '@core/validate'
import { fix, hangman, investigate } from '../../../../src/patterns/index'
import { Run } from '../../../../src/runtime/driver'
import { ScriptedProvider } from '../../../../src/runtime/scripted-provider'
import type { RunMessage } from './api'
import {
  applyMessage,
  currentFrame,
  decorate,
  fromFlow,
  IDLE_VIEW,
  metaOf,
  newNode,
  phaseDisplay,
  replayView,
  startLive,
  streamFor,
  toFlow,
  uniqueId,
  withNode,
  type RunView,
} from './model'

async function liveMessages(): Promise<{ messages: RunMessage[]; run: Run }> {
  const score = compileScore(fix, { goal: 'g', context: fix.demo!.context!, generatedAt: 't' })
  const run = new Run({ score, provider: ScriptedProvider.forPattern(fix), demo: fix.demo, autoApprove: true, clock: () => 't' })
  await run.start()
  return { messages: run.messages, run }
}

describe('canvas mapping', () => {
  it('round-trips a pattern through React Flow shapes', () => {
    const { demo: _d, ...data } = fix
    const flow = toFlow(patternToGraph(fix))
    const back = fromFlow(metaOf(data), flow.nodes, flow.edges)
    expect(back.nodes).toEqual(fix.nodes)
    expect(back.edges).toEqual(fix.edges)
    expect(validateGraph(back).errors).toEqual([])
  })

  it('creates palette nodes and unique ids', () => {
    const n = newNode('executor', 'agent1', { x: 0, y: 0 })
    expect(n.data.node).toMatchObject({ kind: 'agent', role: 'executor' })
    expect(uniqueId('agent', ['agent1', 'agent2'])).toBe('agent3')
  })

  it('refreshes reads/writes when a node is edited', () => {
    const n = newNode('assessor', 'a', { x: 0, y: 0 })
    const edited = withNode(n, { ...(n.data.node as Extract<typeof n.data.node, { kind: 'agent' }>), reads: ['x'], writes: ['y'] }, [])
    expect(edited.data).toMatchObject({ reads: ['x'], writes: ['y'] })
  })
})

describe('phases on the canvas', () => {
  const { demo: _d, ...data } = investigate
  const flow = toFlow(patternToGraph(investigate))
  const frame = {
    ...EMPTY_FRAME,
    nodeStatus: { catalog: 'done', plan: 'done', queue: 'done', needFiles: 'done', inventory: 'active' },
    nodeVisits: { catalog: 1, plan: 1, queue: 1, needFiles: 1, inventory: 1 },
  } as const
  const steps = decorate(flow.nodes, flow.edges, frame, { breakpoints: new Set(), issues: new Map() })

  it('keeps phases through the canvas round-trip, dropping deleted steps', () => {
    const back = fromFlow(
      metaOf(data),
      flow.nodes.filter((n) => n.id !== 'listPages'),
      flow.edges,
    )
    expect(back.groups?.map((g) => g.id)).toEqual(investigate.groups!.map((g) => g.id))
    expect(back.groups!.find((g) => g.id === 'listPhase')!.nodes).not.toContain('listPages')
  })

  it('draws each closed phase as one node with the status of its busiest step', () => {
    const d = phaseDisplay(data, steps, new Set(), frame)
    expect(d.collapsed).toBe(true)
    const ids = d.nodes.map((n) => n.id)
    expect(ids).toContain('listPhase')
    expect(ids).not.toContain('inventory')
    const plan = d.nodes.find((n) => n.id === 'planPhase')!
    const list = d.nodes.find((n) => n.id === 'listPhase')!
    expect(plan.data).toMatchObject({ status: 'done', ran: 3 })
    expect(list.data).toMatchObject({ status: 'active', current: 'List every file', ran: 2 })
    expect(d.phaseOf.get('inventory')).toBe('listPhase')
    for (const e of d.edges) {
      expect(ids).toContain(e.source)
      expect(ids).toContain(e.target)
    }
    expect(d.edges.some((e) => e.source === 'planPhase' && e.target === 'listPhase')).toBe(true)
  })

  it('frames opened phases behind their steps', () => {
    const d = phaseDisplay(data, steps, new Set(['listPhase']), frame)
    expect(d.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['frame:listPhase', 'inventory', 'planPhase']))
    const all = phaseDisplay(data, steps, new Set(investigate.groups!.map((g) => g.id)), frame)
    expect(all.collapsed).toBe(false)
    expect(all.nodes.filter((n) => n.type === 'frame')).toHaveLength(investigate.groups!.length)
  })

  it('passes flows without phases straight through', () => {
    const { demo: _h, ...plain } = hangman
    const f = toFlow(patternToGraph(hangman))
    expect(phaseDisplay(plain, f, new Set(), EMPTY_FRAME).nodes).toHaveLength(f.nodes.length)
  })
})

describe('live run view', () => {
  it('folds messages into frames, streams and final state', async () => {
    const { messages, run } = await liveMessages()
    let v: RunView = startLive(run.id)
    for (const m of messages) v = applyMessage(v, m)
    expect(v.status).toBe('done')
    expect(currentFrame(v).state).toEqual(run.engine.state)
    expect(v.performance?.outcome).toBe('success')
    const applyStreams = v.streams.filter((s) => s.nodeId === 'apply')
    expect(applyStreams).toHaveLength(2)
    expect(applyStreams[0]!.text.length).toBeGreaterThan(0)
    expect(applyStreams[0]!.tools[0]).toMatchObject({ name: 'submit_result', ok: true })
    expect(v.pause).toBeUndefined()
  })

  it('tracks gates and the proposed result', () => {
    let v = startLive('r')
    v = applyMessage(v, { seq: 0, type: 'engine', event: { type: 'paused', pause: { kind: 'agent', pauseId: 'p', step: 2, nodeId: 'a', role: 'assessor', label: 'A', directive: 'd', goal: 'g', context: {}, input: {}, outputSchema: [], capabilities: [], complexity: 2, improvisation: 0, isolated: false, takes: 1, attempt: 1, maxAttempts: 2, moveKey: 'm' } } })
    v = applyMessage(v, { seq: 1, type: 'status', status: 'paused', nodeId: 'a', phase: 'after', proposed: { updates: {} } })
    expect(v.gate).toEqual({ nodeId: 'a', phase: 'after', proposed: { updates: {} } })
    expect(v.streams[0]).toMatchObject({ key: '2:a:1', result: { updates: {} } })
    v = applyMessage(v, { seq: 2, type: 'status', status: 'running', nodeId: 'a' })
    expect(v.gate).toBeUndefined()
  })
})

describe('replay view and decoration', () => {
  it('builds frames and transcripts from a saved run and decorates the canvas', async () => {
    const { run } = await liveMessages()
    const perf = run.messages.find((m) => m.type === 'performance')!
    if (perf.type !== 'performance') throw new Error('no performance')
    const v = replayView({ schemaVersion: 2, score: run.score, performance: perf.performance }, { reproduced: true, issues: [] })
    expect(v.mode).toBe('replay')
    expect(v.frames.length).toBe(perf.performance.events.length)
    const frame = currentFrame(v)
    expect(streamFor(v, 'verify', frame)?.result).toMatchObject({ updates: { testsPassed: true } })
    const flow = toFlow(patternToGraph(fix))
    const d = decorate(flow.nodes, flow.edges, frame, { breakpoints: new Set(['apply']), issues: new Map([['diagnose', ['bad']]]) })
    expect(d.nodes.find((n) => n.id === 'apply')!.data).toMatchObject({ breakpoint: true, visits: 2, status: 'done' })
    expect(d.nodes.find((n) => n.id === 'diagnose')!.data.issues).toEqual(['bad'])
    expect(d.edges.find((e) => e.id === 'budget-apply')!.data!.count).toBe(1)
  })

  it('starts idle', () => {
    expect(currentFrame(IDLE_VIEW).index).toBe(-1)
    expect(hangman.name).toBe('hangman')
  })
})
