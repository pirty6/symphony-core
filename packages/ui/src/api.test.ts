import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startRun, stopRun, sendMessage, approveStep } from './api'
import type { RunCallbacks } from './api'

// Mock fetch for all tests
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function createSSEStream(frames: { event: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        const text = frames
          .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
          .join('')
        controller.enqueue(encoder.encode(text))
        controller.close()
      }
    },
  })
}

function createCallbacks(): RunCallbacks & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    onSessionId: [],
    onMessage: [],
    onTurnDone: [],
    onToolStart: [],
    onToolEnd: [],
    onStepPending: [],
    onError: [],
  }
  return {
    calls,
    onSessionId: (id) => { calls.onSessionId.push([id]) },
    onMessage: (content) => { calls.onMessage.push([content]) },
    onTurnDone: () => { calls.onTurnDone.push([]) },
    onToolStart: (toolName, toolArgs) => { calls.onToolStart.push([toolName, toolArgs]) },
    onToolEnd: (toolName, agentName, result) => { calls.onToolEnd.push([toolName, agentName, result]) },
    onStepPending: (toolName, toolArgs) => { calls.onStepPending.push([toolName, toolArgs]) },
    onError: (message) => { calls.onError.push([message]) },
  }
}

describe('api', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('startRun', () => {
    it('sends POST /api/run with prompt and debug flag', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([]),
      })

      const callbacks = createCallbacks()
      startRun('test prompt', callbacks, true)
      await new Promise((r) => setTimeout(r, 10))

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/run',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'test prompt', debug: true }),
        }),
      )
    })

    it('parses session SSE event and calls onSessionId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([{ event: 'session', data: { id: '42' } }]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onSessionId).toEqual([['42']])
    })

    it('parses message SSE event and calls onMessage', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([
          { event: 'session', data: { id: '1' } },
          { event: 'message', data: { content: 'Hello world' } },
        ]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onMessage).toEqual([['Hello world']])
    })

    it('parses turn-done SSE event', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([
          { event: 'session', data: { id: '1' } },
          { event: 'turn-done', data: { sessionId: '1' } },
        ]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onTurnDone).toHaveLength(1)
    })

    it('parses tool-start SSE event', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([
          { event: 'session', data: { id: '1' } },
          { event: 'tool-start', data: { toolName: 'task', toolArgs: { name: 'assessor' } } },
        ]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onToolStart).toEqual([['task', { name: 'assessor' }]])
    })

    it('parses tool-end SSE event', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([
          { event: 'session', data: { id: '1' } },
          { event: 'tool-end', data: { toolName: 'task', agentName: 'executor', result: 'done' } },
        ]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onToolEnd).toEqual([['task', 'executor', 'done']])
    })

    it('parses step-pending SSE event', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([
          { event: 'session', data: { id: '1' } },
          { event: 'step-pending', data: { toolName: 'task', toolArgs: { name: 'exec' } } },
        ]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onStepPending).toEqual([['task', { name: 'exec' }]])
    })

    it('parses error SSE event', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([
          { event: 'error', data: { message: 'Something failed' } },
        ]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onError).toEqual([['Something failed']])
    })

    it('calls onError for non-OK HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server crashed' }),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onError).toEqual([['Server crashed']])
    })

    it('calls onError on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'))

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onError).toEqual([['Network error']])
    })

    it('does not call onError when aborted', async () => {
      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      mockFetch.mockRejectedValue(abortError)

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onError).toEqual([])
    })

    it('returns an AbortController', () => {
      mockFetch.mockResolvedValue({ ok: true, body: createSSEStream([]) })
      const controller = startRun('test', createCallbacks())
      expect(controller).toBeInstanceOf(AbortController)
    })

    it('handles multiple SSE events in sequence', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream([
          { event: 'session', data: { id: '1' } },
          { event: 'message', data: { content: 'First' } },
          { event: 'tool-start', data: { toolName: 'task', toolArgs: {} } },
          { event: 'tool-end', data: { toolName: 'task', agentName: 'a', result: 'r' } },
          { event: 'message', data: { content: 'Second' } },
          { event: 'turn-done', data: { sessionId: '1' } },
        ]),
      })

      const callbacks = createCallbacks()
      startRun('test', callbacks)
      await new Promise((r) => setTimeout(r, 50))

      expect(callbacks.calls.onSessionId).toHaveLength(1)
      expect(callbacks.calls.onMessage).toHaveLength(2)
      expect(callbacks.calls.onToolStart).toHaveLength(1)
      expect(callbacks.calls.onToolEnd).toHaveLength(1)
      expect(callbacks.calls.onTurnDone).toHaveLength(1)
    })
  })

  describe('stopRun', () => {
    it('sends DELETE /api/run/:id', async () => {
      mockFetch.mockResolvedValue({ ok: true })
      await stopRun('42')
      expect(mockFetch).toHaveBeenCalledWith('/api/run/42', { method: 'DELETE' })
    })
  })

  describe('sendMessage', () => {
    it('sends POST /api/run/:id/message with the message body', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ sent: true }) })
      await sendMessage('42', 'Hello')
      expect(mockFetch).toHaveBeenCalledWith('/api/run/42/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      })
    })

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Session not found' }),
      })
      await expect(sendMessage('99', 'hi')).rejects.toThrow('Session not found')
    })
  })

  describe('approveStep', () => {
    it('sends POST /api/run/:id/step', async () => {
      mockFetch.mockResolvedValue({ ok: true })
      await approveStep('42')
      expect(mockFetch).toHaveBeenCalledWith('/api/run/42/step', { method: 'POST' })
    })
  })
})
