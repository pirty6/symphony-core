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
  endLocally,
  fromFlow,
  IDLE_VIEW,
  metaOf,
  minimapStyle,
  newNode,
  phaseDisplay,
  subAgentNodes,
  replayView,
  changedFromDemo,
  isOfflineDemo,
  musicianLines,
  parseStoredSettings,
  originSummary,
  originsByNode,
  resultMarkdown,
  runResult,
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
    expect(back.goalFrom).toBe('question')
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
    expect(d.edges.some((e) => e.source === 'hypothesesPhase' && e.target === 'listPhase')).toBe(true)
    // Phases can be dragged; where you put one is kept, for this view only.
    const moved = phaseDisplay(data, steps, new Set(), frame, { moved: new Map([['listPhase', { x: 900, y: 7 }]]) })
    const at = moved.nodes.find((n) => n.id === 'listPhase')!
    expect(at.position).toEqual({ x: 900, y: 7 })
    expect(at.draggable).not.toBe(false)
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

describe('origins', () => {
  it('labels who played each node and summarises the run', async () => {
    const { messages } = await liveMessages()
    const done = messages.find((m) => m.type === 'performance')
    const perf = done?.type === 'performance' ? done.performance : undefined
    if (!perf) throw new Error('no performance')
    const by = originsByNode(perf)
    const agent = perf.steps.find((s) => s.kind === 'agent')!
    expect(by.get(agent.nodeId)?.origin).toBe('script')
    expect(originsByNode(perf, 0).size).toBe(0)
    expect(originSummary(perf)).toMatch(/^\d+ scripted · .*\d+ engine$/)
  })
})

describe('offline demo', () => {
  it('keeps the AI choice, flags canned results and inputs the demo ignores', async () => {
    expect(parseStoredSettings('{"provider":"copilot","model":"m","x":1}')).toEqual({ provider: 'copilot', model: 'm' })
    expect(parseStoredSettings('{"provider":"gpt"}')).toEqual({})
    expect(parseStoredSettings('not json')).toEqual({})
    expect(parseStoredSettings(null)).toEqual({})
    const { messages } = await liveMessages()
    const done = messages.find((m) => m.type === 'performance')
    const perf = done?.type === 'performance' ? done.performance : undefined
    expect(isOfflineDemo(perf)).toBe(true)
    const live = perf && {
      ...perf,
      steps: perf.steps.map((s) => (s.transcript ? { ...s, transcript: { ...s.transcript, provider: 'copilot' } } : s)),
    }
    expect(isOfflineDemo(live)).toBe(false)
    const replayed = perf && {
      ...perf,
      steps: perf.steps.map((s) => (s.transcript ? { ...s, transcript: { ...s.transcript, fromRepertoire: 'r.json' } } : s)),
    }
    expect(isOfflineDemo(replayed)).toBe(true)
    expect(isOfflineDemo(undefined)).toBe(false)
    expect(changedFromDemo({ question: 'mine ' }, { question: 'demo' })).toEqual(['question'])
    expect(changedFromDemo({ question: ' demo' }, { question: 'demo' })).toEqual([])
  })
})

describe('musician', () => {
  it('summarises who played a recorded answer', () => {
    const t = { provider: 'copilot', prompt: '', output: '', toolCalls: [] }
    expect(musicianLines(t)).toEqual([])
    expect(
      musicianLines({ ...t, musician: { tier: 3, requestedModel: 'm', effort: 'high', account: 'token', sdk: 'sdk@1', sampling: 'default' } }),
    ).toEqual(['tier 3 · asked for m (high) · token · sdk@1', 'sampling: default'])
  })
})

describe('live run view', () => {
  it('exposes the result: what was carried into the end node', async () => {
    const { messages } = await liveMessages()
    let v: RunView = startLive('r', 'fix it')
    for (const m of messages.slice(0, 3)) v = applyMessage(v, m)
    expect(runResult(v)).toBeUndefined()
    for (const m of messages.slice(3)) v = applyMessage(v, m)
    const r = runResult(v)!
    expect(r.keys.length).toBeGreaterThan(0)
    expect(Object.keys(r.values)).toEqual([...r.keys])
    expect(v.goal).toBe('fix it')
    const declared = runResult({ ...v, resultKeys: ['tries', 'missing'] })!
    expect(declared.keys).toEqual(['tries', 'missing'])
    expect(Object.keys(declared.values)).toEqual(['tries', 'missing'])
    expect(resultMarkdown({ keys: ['answer', 'open'], values: { answer: 'Yes.', open: ['a'] } }, 'run')).toBe(
      '# run\n\n## answer\n\nYes.\n\n## open\n\n- a\n',
    )
  })

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
    const v = replayView({ schemaVersion: 3, score: run.score, performance: perf.performance }, { reproduced: true, issues: [] })
    expect(v.mode).toBe('replay')
    expect(v.frames.length).toBe(perf.performance.events.length)
    const frame = currentFrame(v)
    expect(streamFor(v, 'diagnose', frame)?.result).toMatchObject({ updates: { files: ['src/paginate.ts', 'src/paginate.test.ts'] } })
    const flow = toFlow(patternToGraph(fix))
    const d = decorate(flow.nodes, flow.edges, frame, { breakpoints: new Set(['apply']), issues: new Map([['diagnose', ['bad']]]) })
    expect(d.nodes.find((n) => n.id === 'apply')!.data).toMatchObject({ breakpoint: true, visits: 2, status: 'done' })
    expect(d.nodes.find((n) => n.id === 'diagnose')!.data.issues).toEqual(['bad'])
    expect(d.edges.find((e) => e.id === 'planWrong-apply')!.data!.count).toBe(1)
  })

  it('starts idle', () => {
    expect(currentFrame(IDLE_VIEW).index).toBe(-1)
    expect(hangman.name).toBe('hangman')
  })
})

describe('endLocally', () => {
  it('ends a paused run on screen so no gate or approval waits for an answer nobody receives', () => {
    const paused: RunView = {
      ...startLive('r', 'g'),
      status: 'paused',
      gate: { nodeId: 'recall', phase: 'before' },
      pause: { kind: 'approval' } as RunView['pause'],
    }
    const ended = endLocally(paused, 'gone')
    expect(ended).toMatchObject({ runId: 'r', status: 'cancelled', reason: 'gone' })
    expect(ended.gate).toBeUndefined()
    expect(ended.pause).toBeUndefined()
  })
})

describe('minimapStyle', () => {
  it('lights up where the run is, as the diagram does; idle nodes stay dim', () => {
    expect(minimapStyle(undefined)).toEqual({ fill: '#2a3156', stroke: '#2a3156', className: '' })
    expect(minimapStyle('active')).toMatchObject({ fill: '#fbbf24', className: 'minimap-active' })
    expect(minimapStyle('paused')).toMatchObject({ fill: '#34d399', className: 'minimap-paused' })
    expect(minimapStyle('failed').fill).toBe('#ef4444')
    expect(minimapStyle('done').className).toBe('minimap-done')
  })
})

describe('sub-agents on the canvas', () => {
  it('each part of a fanned-out step is a node beside it, with its state', async () => {
    const score = compileScore(investigate, {
      goal: 'g',
      context: { ...investigate.demo!.context!, batchSize: 1, agents: 2 },
      generatedAt: 't',
    })
    const run = new Run({ score, provider: ScriptedProvider.forPattern(investigate), demo: investigate.demo, autoApprove: true, clock: () => 't' })
    await run.start()
    const parts = run.messages.filter((m) => m.type === 'part')
    expect(parts.length).toBeGreaterThan(0)
    // Replay the messages up to the first part that finished.
    let v: RunView = startLive('r')
    for (const m of run.messages) {
      v = applyMessage(v, m)
      if (m.type === 'part' && m.state === 'done') break
    }
    expect(v.parts!.nodeId).toBe('triage')
    // Two sub-agents at a time; a wave holds twice as many parts.
    expect(v.parts!.states).toEqual(['done', 'running', 'waiting', 'waiting'])
    const anchor = { id: 'triage', type: 'agent', position: { x: 100, y: 200 }, data: {} } as never
    const { nodes, edges } = subAgentNodes(v.parts, [anchor], new Map())
    expect(nodes.map((n) => n.id)).toEqual(['sub:triage:1', 'sub:triage:2', 'sub:triage:3', 'sub:triage:4'])
    expect(nodes.every((n) => n.position.x > 100)).toBe(true)
    expect(edges.map((e) => [e.source, e.target, e.animated])).toEqual([
      ['triage', 'sub:triage:1', false],
      ['triage', 'sub:triage:2', true],
      ['triage', 'sub:triage:3', false],
      ['triage', 'sub:triage:4', false],
    ])
    // Inside a closed phase, they hang off the phase.
    const phase = { id: 'triagePhase', type: 'phase', position: { x: 0, y: 0 }, data: {} } as never
    expect(subAgentNodes(v.parts, [phase], new Map([['triage', 'triagePhase']])).edges[0]!.source).toBe('triagePhase')
  })
})
