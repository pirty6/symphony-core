import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compileScore } from '@core/compile'
import { parseDraft } from '@core/draft'
import { patternToGraph } from '@core/graph'
import { PATTERNS } from '../../../src/patterns/index'
import { Run, type RunMessage } from '../../../src/runtime/driver'
import { ScriptedProvider } from '../../../src/runtime/scripted-provider'
import Studio from './Studio'

/**
 * Drives the real Studio against the real engine/driver in-process:
 * fetch + EventSource are routed to Run instances, like the dev server does.
 */
const runs = new Map<string, Run>()
const sources: FakeEventSource[] = []

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null
  closed = false
  private off: (() => void) | undefined
  constructor(url: string) {
    sources.push(this)
    const id = /\/api\/runs\/([^/]+)\/events/.exec(url)![1]!
    const run = runs.get(id)!
    queueMicrotask(() => {
      const send = (m: RunMessage) => !this.closed && act(() => this.onmessage?.({ data: JSON.stringify(m) }))
      for (const m of [...run.messages]) send(m)
      this.off = run.subscribe(send)
    })
  }
  close() {
    this.closed = true
    this.off?.()
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  if (url === '/api/patterns') {
    return json(PATTERNS.map(({ demo, ...p }) => ({ ...p, source: 'builtin', graph: patternToGraph(p), demo: demo ? { goal: demo.goal ?? '', context: demo.context ?? {} } : undefined })))
  }
  if (url === '/api/saved') return json([])
  if (url === '/api/runs' && init?.method === 'POST') {
    const parsed = parseDraft(body.pattern)
    if (!parsed.ok) return json({ error: 'invalid', issues: [] }, 400)
    const builtin = PATTERNS.find((p) => p.name === parsed.value.name)
    const score = compileScore(parsed.value, { goal: String(body.goal), context: body.context as Record<string, unknown> })
    const run = new Run({
      score,
      provider: new ScriptedProvider(builtin?.demo ? { demo: builtin.demo } : {}),
      ...(builtin?.demo ? { demo: builtin.demo } : {}),
      autoApprove: body.autoApprove === true,
      stepMode: body.stepMode === true,
      breakpoints: (body.breakpoints as string[]) ?? [],
    })
    runs.set(run.id, run)
    void run.start()
    return json({ runId: run.id, score })
  }
  const m = /^\/api\/runs\/([^/]+)\/(control|approval)$/.exec(url)
  if (m) {
    const run = runs.get(m[1]!)!
    if (m[2] === 'approval') run.answerApproval(body as never)
    else if (body.action === 'stepMode') run.setStepMode(body.on === true)
    else if (body.action === 'breakpoints') run.setBreakpoints(body.breakpoints as string[])
    else (run[body.action as 'pause' | 'resume' | 'step' | 'stop'] as () => void).call(run)
    return json({ ok: true })
  }
  return json({ error: `unhandled ${url}` }, 404)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.stubGlobal('EventSource', FakeEventSource)
  location.hash = '#hangman'
})

afterEach(() => {
  for (const r of runs.values()) r.stop()
  runs.clear()
  sources.length = 0
  vi.unstubAllGlobals()
})

function renderStudio() {
  return render(
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>,
  )
}

async function guess(letter: string) {
  const card = await screen.findByTestId('approval-card')
  fireEvent.change(within(card).getByLabelText('letter'), { target: { value: letter } })
  fireEvent.click(within(card).getByText('Approve'))
  await waitFor(() => expect(screen.queryByTestId('approval-card')).toBeNull())
}

describe('Studio (integration)', () => {
  it('loads the library and the requested pattern', async () => {
    renderStudio()
    expect(await screen.findByText('Play a round of hangman')).toBeInTheDocument()
    expect(screen.getByTestId('node-pick')).toBeInTheDocument()
    expect(screen.getByText(/Valid: every path is bounded/)).toBeInTheDocument()
  })

  it('runs live: AI node streams, human answers approvals, run completes', async () => {
    renderStudio()
    await screen.findByText('Play a round of hangman')
    fireEvent.click(screen.getByText('▶ Run'))
    for (const l of ['p', 'l', 'a', 'n', 'e', 't']) await guess(l)
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('done'))
    expect(screen.getByTestId('run-result')).toHaveTextContent(/success/)
    expect(screen.getByTestId('node-win')).toHaveAttribute('data-status', 'done')
    expect(screen.getByTestId('node-lose')).toHaveAttribute('data-status', 'idle')
    fireEvent.click(screen.getByText('State'))
    expect(screen.getByTestId('state-won')).toHaveTextContent('true')
    expect(screen.getByTestId('timeline-events')).toHaveTextContent('success: reached end')
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([u]) => u === '/api/runs')![1]!.body)) as { pattern: { name: string } }
    expect(body.pattern.name).toBe('hangman')
  })

  it('step mode pauses before the AI and shows its proposed answer before applying it', async () => {
    renderStudio()
    await screen.findByText('Play a round of hangman')
    fireEvent.click(screen.getByLabelText('step mode'))
    fireEvent.click(screen.getByText('▶ Run'))
    const gate = await screen.findByTestId('gate-card')
    expect(gate).toHaveTextContent('Paused before “pick”')
    expect(screen.getByTestId('node-pick')).toHaveClass('at-gate')
    fireEvent.click(within(gate).getByText('⏭ Step'))
    await waitFor(() => expect(screen.getByTestId('proposed-result')).toHaveTextContent('planet'))
    expect(screen.getByTestId('ai-output')).toHaveTextContent('Working on "Pick word"')
    fireEvent.click(within(screen.getByTestId('gate-card')).getByText('⏹ Stop'))
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('cancelled'))
  })

  it('blocks runs while the graph is invalid and points at the node', async () => {
    renderStudio()
    await screen.findByText('Play a round of hangman')
    fireEvent.click(screen.getByTestId('node-over'))
    fireEvent.change(screen.getByLabelText('expression'), { target: { value: 'won ||' } })
    expect(screen.getByText('▶ Run')).toBeDisabled()
    expect(screen.getByTestId('node-over')).toHaveClass('has-issues')
    expect(screen.getByTestId('node-issue')).toHaveTextContent(/condition 'won \|\|' is invalid/)
  })
})
