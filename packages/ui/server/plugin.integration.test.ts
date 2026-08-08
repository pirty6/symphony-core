import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'

// Mock the copilot-sdk before importing plugin
const mockStart = vi.fn().mockResolvedValue(undefined)
const mockStop = vi.fn().mockResolvedValue(undefined)
const mockDisconnect = vi.fn().mockResolvedValue(undefined)
const mockSessionSend = vi.fn().mockResolvedValue(undefined)
const mockSessionOn = vi.fn()

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class MockCopilotClient {
    start = mockStart
    stop = mockStop
    createSession = vi.fn().mockResolvedValue({
      on: mockSessionOn,
      send: mockSessionSend,
      disconnect: mockDisconnect,
    })
  },
}))

// Mock hooks
vi.mock('../../../src/hooks/onErrorOccurred.js', () => ({
  onErrorOccurred: vi.fn(),
}))
vi.mock('../../../src/hooks/onUserPromptSubmitted.js', () => ({
  onUserPromptSubmitted: vi.fn(),
}))

// Import after mocks
import { symphonyPlugin } from './plugin'

// Helper to create a fake IncomingMessage
function createRequest(method: string, url: string, body?: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  req.method = method
  req.url = url
  // Simulate body streaming
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    }, 0)
  }
  return req
}

// Helper to create a fake ServerResponse
function createResponse(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string; _chunks: string[] } {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    _chunks: [] as string[],
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status
      if (headers) Object.assign(res._headers, headers)
    },
    write(chunk: string) {
      res._chunks.push(chunk)
      res._body += chunk
      return true
    },
    end(data?: string) {
      if (data) res._body += data
    },
  } as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string; _chunks: string[] }
  return res
}

function parseSSEEvents(chunks: string[]): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = []
  const raw = chunks.join('')
  const frames = raw.split('\n\n').filter(Boolean)
  for (const frame of frames) {
    const lines = frame.split('\n')
    let event = ''
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7)
      if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (event && data) {
      events.push({ event, data: JSON.parse(data) })
    }
  }
  return events
}

describe('symphonyPlugin', () => {
  let plugin: ReturnType<typeof symphonyPlugin>
  let middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv, TOKEN: 'test-token', MODEL: 'gpt-4o' }
    plugin = symphonyPlugin()

    // Extract the middleware from configureServer
    const fakeServer = {
      middlewares: {
        use: (fn: typeof middleware) => { middleware = fn },
      },
    }
    ;(plugin as { configureServer: (s: typeof fakeServer) => void }).configureServer(fakeServer)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('has the correct plugin name', () => {
    expect(plugin.name).toBe('symphony-orchestrator')
  })

  describe('routing', () => {
    it('routes POST /api/run to handleRun', async () => {
      const req = createRequest('POST', '/api/run', JSON.stringify({ prompt: 'test', debug: false }))
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      await new Promise((r) => setTimeout(r, 50))

      expect(next).not.toHaveBeenCalled()
      // Should have started SSE
      expect(res._headers['Content-Type']).toBe('text/event-stream')
    })

    it('routes POST /api/run/:id/message to handleMessage', async () => {
      const req = createRequest('POST', '/api/run/9999/message', JSON.stringify({ message: 'hi' }))
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      await new Promise((r) => setTimeout(r, 10))

      expect(next).not.toHaveBeenCalled()
      // Session 9999 doesn't exist → 404
      expect(res._status).toBe(404)
    })

    it('routes POST /api/run/:id/step to handleStep', () => {
      const req = createRequest('POST', '/api/run/9999/step')
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res._status).toBe(404) // no active session
    })

    it('routes DELETE /api/run/:id to handleStop', () => {
      const req = createRequest('DELETE', '/api/run/9999')
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res._status).toBe(404) // no active session
    })

    it('calls next() for unmatched routes', () => {
      const req = createRequest('GET', '/other')
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  describe('handleRun', () => {
    it('returns 500 when TOKEN is missing', async () => {
      delete process.env.TOKEN
      // Need to re-create plugin to pick up env
      const freshPlugin = symphonyPlugin()
      const fakeServer = { middlewares: { use: (fn: typeof middleware) => { middleware = fn } } }
      ;(freshPlugin as { configureServer: (s: typeof fakeServer) => void }).configureServer(fakeServer)

      const req = createRequest('POST', '/api/run', JSON.stringify({ prompt: 'test' }))
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      await new Promise((r) => setTimeout(r, 50))

      expect(res._status).toBe(500)
      expect(res._body).toContain('TOKEN')
    })

    it('returns 400 for invalid JSON body', async () => {
      const req = createRequest('POST', '/api/run', 'not json {{{')
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      await new Promise((r) => setTimeout(r, 50))

      expect(res._status).toBe(400)
      expect(res._body).toContain('Invalid JSON body')
    })

    it('opens SSE stream and sends session event', async () => {
      const req = createRequest('POST', '/api/run', JSON.stringify({ prompt: 'hello', debug: false }))
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      await new Promise((r) => setTimeout(r, 50))

      expect(res._headers['Content-Type']).toBe('text/event-stream')
      expect(res._headers['Cache-Control']).toBe('no-cache')
      expect(res._headers['Connection']).toBe('keep-alive')

      const events = parseSSEEvents(res._chunks)
      const sessionEvent = events.find((e) => e.event === 'session')
      expect(sessionEvent).toBeDefined()
      expect((sessionEvent!.data as { id: string }).id).toMatch(/^\d+$/)
    })

    it('creates CopilotClient and starts a session', async () => {
      const req = createRequest('POST', '/api/run', JSON.stringify({ prompt: 'test prompt' }))
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      // Allow microtasks and the async handleRun to progress through body read + client init
      await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 100))

      expect(mockStart).toHaveBeenCalled()
      expect(mockSessionSend).toHaveBeenCalledWith({ prompt: 'test prompt' })
    })

    it('registers assistant.message and session.idle listeners', async () => {
      const req = createRequest('POST', '/api/run', JSON.stringify({ prompt: 'test' }))
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 100))

      const onCalls = mockSessionOn.mock.calls
      const eventNames = onCalls.map((c: unknown[]) => c[0])
      expect(eventNames).toContain('assistant.message')
      expect(eventNames).toContain('session.idle')
    })
  })

  describe('handleMessage', () => {
    it('returns 404 for non-existent session', async () => {
      const req = createRequest('POST', '/api/run/9999/message', JSON.stringify({ message: 'hi' }))
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)
      await new Promise((r) => setTimeout(r, 10))

      expect(res._status).toBe(404)
      const body = JSON.parse(res._body)
      expect(body.error).toBe('Session not found')
    })
  })

  describe('handleStep', () => {
    it('returns 404 for non-existent session', () => {
      const req = createRequest('POST', '/api/run/9999/step')
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)

      expect(res._status).toBe(404)
      const body = JSON.parse(res._body)
      expect(body.error).toBe('Session not found')
    })
  })

  describe('handleStop', () => {
    it('returns 404 for non-existent session', () => {
      const req = createRequest('DELETE', '/api/run/9999')
      const res = createResponse()
      const next = vi.fn()

      middleware(req, res, next)

      expect(res._status).toBe(404)
      const body = JSON.parse(res._body)
      expect(body.error).toBe('Session not found')
    })
  })
})
