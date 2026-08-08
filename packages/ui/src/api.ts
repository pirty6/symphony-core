const API_BASE = '/api'

export interface RunCallbacks {
  onSessionId: (id: string) => void
  onMessage: (content: string) => void
  onTurnDone: () => void
  onToolStart: (toolName: string, toolArgs: unknown) => void
  onToolEnd: (toolName: string, agentName?: string, result?: string) => void
  onStepPending: (toolName: string, toolArgs: unknown) => void
  onError: (message: string) => void
}

/**
 * Start a Copilot SDK session via the backend server.
 * The session stays alive for follow-up messages until stopped.
 * Returns an AbortController to cancel the SSE stream.
 */
export function startRun(prompt: string, callbacks: RunCallbacks, debug = false): AbortController {
  console.log(`[symphony:api] startRun called (prompt ${prompt.length} chars, debug=${debug})`)
  const controller = new AbortController()

  fetch(`${API_BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, debug }),
    signal: controller.signal,
  })
    .then(async (res) => {
      console.log(`[symphony:api] Fetch response — status=${res.status}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Server error' }))
        callbacks.onError(err.error ?? `HTTP ${res.status}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        callbacks.onError('No response body')
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE frames
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        let eventType = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7)
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6))
            switch (eventType) {
              case 'session':
                callbacks.onSessionId(data.id)
                break
              case 'message':
                callbacks.onMessage(data.content)
                break
              case 'turn-done':
                callbacks.onTurnDone()
                break
              case 'tool-start':
                callbacks.onToolStart(data.toolName, data.toolArgs)
                break
              case 'tool-end':
                callbacks.onToolEnd(data.toolName, data.agentName, data.result)
                break
              case 'step-pending':
                callbacks.onStepPending(data.toolName, data.toolArgs)
                break
              case 'error':
                callbacks.onError(data.message)
                break
            }
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        console.error(`[symphony:api] Fetch error: ${err.message}`)
        callbacks.onError(err.message)
      } else {
        console.log('[symphony:api] Fetch aborted')
      }
    })

  return controller
}

export async function stopRun(sessionId: string): Promise<void> {
  console.log(`[symphony:api] stopRun called — sessionId=${sessionId}`)
  await fetch(`${API_BASE}/run/${sessionId}`, { method: 'DELETE' })
}

export async function sendMessage(sessionId: string, message: string): Promise<void> {
  console.log(`[symphony:api] sendMessage called — sessionId=${sessionId}, message=${message.length} chars`)
  const res = await fetch(`${API_BASE}/run/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Send failed' }))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
}

export async function approveStep(sessionId: string): Promise<void> {
  console.log(`[symphony:api] approveStep called — sessionId=${sessionId}`)
  await fetch(`${API_BASE}/run/${sessionId}/step`, { method: 'POST' })
}
