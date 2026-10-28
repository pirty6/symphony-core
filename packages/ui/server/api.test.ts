// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fix, hangman } from '../../../src/patterns/index.js'
import { createApi } from './api.ts'

const root = mkdtempSync(join(tmpdir(), 'symphony-api-'))
let server: Server
let base = ''

beforeAll(async () => {
  const api = createApi({ repoRoot: root, importer: (f) => import(pathToFileURL(f).href), env: {} })
  server = createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const data = (p: typeof fix) => {
  const { demo: _demo, ...rest } = p
  return rest
}

/** Read an SSE stream, calling onMessage for each data payload, until the server closes it. */
async function readSse(res: Response, onMessage?: (m: Record<string, unknown>) => void): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      const msg = JSON.parse(line.slice(6)) as Record<string, unknown>
      out.push(msg)
      onMessage?.(msg)
    }
  }
  return out
}

describe('studio api', () => {
  it('lists the pattern library with graphs and demo inputs', async () => {
    const list = (await (await fetch(`${base}/api/patterns`)).json()) as { name: string; graph: { nodes: unknown[] }; demo?: { context: unknown } }[]
    const fixItem = list.find((p) => p.name === 'fix')!
    expect(fixItem.graph.nodes.length).toBe(fix.nodes.length)
    expect(fixItem.demo?.context).toEqual(fix.demo!.context)
  })

  it('runs a pattern, streams events, saves and replays it', async () => {
    const start = (await (await post('/api/runs', { pattern: data(fix), goal: 'fix it', context: fix.demo!.context, provider: 'scripted', autoApprove: true })).json()) as { runId: string }
    const msgs = await readSse(await fetch(`${base}/api/runs/${start.runId}/events`))
    const types = new Set(msgs.map((m) => m.type))
    expect(types).toEqual(new Set(['status', 'engine', 'provider', 'performance']))
    expect(msgs.at(-1)).toMatchObject({ type: 'status', status: 'done' })
    const saved = (await (await fetch(`${base}/api/saved`)).json()) as { file: string }[]
    expect(saved).toHaveLength(1)
    const file = (await (await fetch(`${base}/api/saved/file?path=${encodeURIComponent(saved[0]!.file)}`)).json()) as { reproduced: boolean; issues: string[] }
    expect(file).toMatchObject({ reproduced: true, issues: [] })
  })

  it('forks a saved run from a step and refuses to resume a finished one', async () => {
    const [first] = (await (await fetch(`${base}/api/saved`)).json()) as { file: string }[]
    const settings = { provider: 'scripted', autoApprove: true, stepMode: false, breakpoints: [] }
    const refused = await post('/api/runs/continue', { file: first!.file, kind: 'resumed', ...settings })
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { error: string }).error).toMatch(/already ended \(success\)/)
    const bad = await post('/api/runs/continue', { file: '../../etc/passwd', kind: 'forked', atStep: 2, ...settings })
    expect(bad.status).toBe(400)
    const fork = (await (await post('/api/runs/continue', { file: first!.file, kind: 'forked', atStep: 2, ...settings })).json()) as { runId: string }
    const msgs = await readSse(await fetch(`${base}/api/runs/${fork.runId}/events`))
    const done = msgs.find((m) => m.type === 'performance') as { performance: { outcome: string; basedOn: unknown }; savedTo: string }
    expect(done.performance).toMatchObject({ outcome: 'success', basedOn: { kind: 'forked', from: first!.file, throughStep: 1 } })
    const saved = (await (await fetch(`${base}/api/saved`)).json()) as { file: string }[]
    const forked = saved.find((r) => r.file !== first!.file)!
    const check = (await (await fetch(`${base}/api/saved/file?path=${encodeURIComponent(forked.file)}`)).json()) as { reproduced: boolean }
    expect(check.reproduced).toBe(true)
  })

  it('pauses in step mode and accepts human approvals', async () => {
    const start = (await (await post('/api/runs', { pattern: data(hangman), provider: 'scripted', stepMode: true })).json()) as { runId: string }
    const id = start.runId
    let approvals = 0
    const msgs = await readSse(await fetch(`${base}/api/runs/${id}/events`), (m) => {
      if (m.type === 'status' && m.status === 'paused') {
        if (m.nodeId === 'pick' && m.phase === 'after') {
          expect(m.proposed).toMatchObject({ updates: { word: 'planet' } })
          void post(`/api/runs/${id}/control`, { action: 'stepMode', on: false }).then(() => post(`/api/runs/${id}/control`, { action: 'resume' }))
        } else void post(`/api/runs/${id}/control`, { action: 'step' })
      }
      if (m.type === 'status' && m.status === 'awaiting-approval') {
        approvals += 1
        void post(`/api/runs/${id}/approval`, { scripted: true })
      }
    })
    expect(approvals).toBe(7)
    expect(msgs.find((m) => m.type === 'performance')).toMatchObject({ performance: { outcome: 'success' } })
  })

  it('stops a running flow', async () => {
    const start = (await (await post('/api/runs', { pattern: data(hangman), provider: 'scripted' })).json()) as { runId: string }
    const msgs = await readSse(await fetch(`${base}/api/runs/${start.runId}/events`), (m) => {
      if (m.type === 'status' && m.status === 'awaiting-approval') void post(`/api/runs/${start.runId}/control`, { action: 'stop' })
    })
    expect(msgs.at(-1)).toMatchObject({ status: 'cancelled' })
  })

  it('rejects invalid patterns and unknown runs', async () => {
    const bad = await post('/api/runs', { pattern: { ...data(fix), nodes: [] }, provider: 'scripted' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0)
    expect((await post('/api/runs/nope/control', { action: 'pause' })).status).toBe(404)
    expect((await post('/api/runs', { pattern: data(fix), provider: 'gpt' })).status).toBe(400)
  })

  it('validates, generates TypeScript and saves drafts into the library', async () => {
    expect(await (await post('/api/validate', { pattern: data(fix) })).json()).toEqual({ errors: [], warnings: [] })
    const ts = (await (await post('/api/typescript', { pattern: data(fix) })).json()) as { source: string }
    expect(ts.source).toContain('export const fix: Pattern')
    const msgs = await readSse(await post('/api/draft', { request: 'Upgrade dependencies safely', provider: 'scripted' }))
    const done = msgs.find((m) => m.type === 'done') as { pattern: { name: string } }
    expect(done.pattern.name).toBe('upgrade-dependencies-safely')
    expect((await post('/api/patterns', { pattern: done.pattern })).status).toBe(200)
    const list = (await (await fetch(`${base}/api/patterns`)).json()) as { name: string; source: string }[]
    expect(list.find((p) => p.name === 'upgrade-dependencies-safely')?.source).toBe('draft')
  })

  it('refuses cross-site and non-JSON POSTs', async () => {
    const plain = await fetch(`${base}/api/patterns`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })
    expect(plain.status).toBe(403)
    const cross = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ pattern: data(fix), provider: 'scripted' }),
    })
    expect(cross.status).toBe(403)
  })
})
