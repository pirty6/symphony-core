import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../../.env') })

import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CopilotClient } from '@github/copilot-sdk'
import type { SessionConfig, PreToolUseHookInput, PostToolUseHookInput, PostToolUseFailureHookInput } from '@github/copilot-sdk'
import { onErrorOccurred } from '../../../src/hooks/onErrorOccurred.js'
import { onUserPromptSubmitted } from '../../../src/hooks/onUserPromptSubmitted.js'

type SessionHooks = NonNullable<SessionConfig['hooks']>

interface TaskToolArgs {
  name?: string
  prompt?: string
  agent_type?: string
  description?: string
  mode?: string
}

function parseTaskArgs(toolArgs: unknown): TaskToolArgs {
  if (typeof toolArgs === 'string') {
    try { return JSON.parse(toolArgs) } catch { return {} }
  }
  return (toolArgs as TaskToolArgs) ?? {}
}

const activeSessions = new Map<string, {
  abort: () => void
  send: (msg: string) => Promise<void>
  approveStep: (() => void) | null
}>()
let sessionCounter = 0

function createHooks(
  sseSend: (event: string, data: unknown) => void,
  sessionId: string,
  debug: boolean,
): SessionHooks {
  return {
    onSessionStart: async (input: { source: string }) => {
      console.log(`[server] Session ${sessionId} ─── onSessionStart (source=${input.source}) ───`)
      return { additionalContext: 'Symphony orchestrator session initialized.' }
    },
    onSessionEnd: async (input: { reason: string }) => {
      console.log(`[server] Session ${sessionId} ─── onSessionEnd (reason=${input.reason}) ───`)
    },
    onUserPromptSubmitted,
    onPreToolUse: async (input: PreToolUseHookInput) => {
      const args = parseTaskArgs(input.toolArgs)
      const agentName = args.name ?? input.toolName
      console.log(`[server] Session ${sessionId} ─── onPreToolUse ───`)
      console.log(`  tool: ${input.toolName}`)
      console.log(`  agent: ${agentName}`)
      if (args.description) console.log(`  description: ${args.description}`)
      if (args.prompt) console.log(`  prompt: ${args.prompt.slice(0, 200)}${args.prompt.length > 200 ? '…' : ''}`)
      if (args.agent_type) console.log(`  agent_type: ${args.agent_type}`)
      if (args.mode) console.log(`  mode: ${args.mode}`)
      sseSend('tool-start', { toolName: input.toolName, toolArgs: input.toolArgs })

      if (debug) {
        console.log(`[server] Session ${sessionId} — debug: waiting for step approval...`)
        sseSend('step-pending', { toolName: input.toolName, toolArgs: input.toolArgs })
        await new Promise<void>((resolve) => {
          const session = activeSessions.get(sessionId)
          if (session) {
            session.approveStep = resolve
          } else {
            resolve()
          }
        })
        console.log(`[server] Session ${sessionId} — debug: step approved for ${agentName}`)
      }

      return { permissionDecision: 'allow' as const, modifiedArgs: input.toolArgs }
    },
    onPostToolUse: async (input: PostToolUseHookInput) => {
      const args = parseTaskArgs(input.toolArgs)
      const agentName = args.name ?? input.toolName
      const result = input.toolResult
      console.log(`[server] Session ${sessionId} ─── onPostToolUse ───`)
      console.log(`  tool: ${input.toolName}`)
      console.log(`  agent: ${agentName}`)
      console.log(`  resultType: ${result.resultType}`)
      if (result.error) console.log(`  error: ${result.error}`)
      const output = result.textResultForLlm
      if (output) {
        console.log(`  output (${output.length} chars): ${output.slice(0, 300)}${output.length > 300 ? '…' : ''}`)
      }
      sseSend('tool-end', { toolName: input.toolName, agentName, result: output?.slice(0, 500) })
      return {}
    },
    onPostToolUseFailure: async (input: PostToolUseFailureHookInput) => {
      const agentName = (input as unknown as { toolArgs: unknown }).toolArgs
        ? parseTaskArgs((input as unknown as { toolArgs: unknown }).toolArgs).name ?? input.toolName
        : input.toolName
      console.log(`[server] Session ${sessionId} ─── onPostToolUseFailure ───`)
      console.log(`  tool: ${input.toolName}`)
      console.log(`  agent: ${agentName}`)
      console.log(`  error: ${input.error}`)
      sseSend('tool-end', { toolName: input.toolName, agentName })
      if (input.toolName === 'run_in_terminal') {
        return { additionalContext: 'Terminal command failed. Stop and report.' }
      }
      return { additionalContext: 'Suggest checking inputs and retrying.' }
    },
    onErrorOccurred,
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  console.log('[server] POST /api/run — received request')
  const token = process.env.TOKEN
  if (!token) {
    console.log('[server] ERROR: TOKEN env var missing')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'TOKEN environment variable is required' }))
    return
  }

  const model = process.env.MODEL ?? 'claude-opus-4.6'
  console.log(`[server] Using model: ${model}`)

  let body: { prompt: string; debug?: boolean }
  try {
    body = JSON.parse(await readBody(req))
    console.log(`[server] Prompt length: ${body.prompt.length} chars, debug: ${!!body.debug}`)
  } catch {
    console.log('[server] ERROR: Invalid JSON body')
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const sessionId = String(++sessionCounter)
  console.log(`[server] Assigned sessionId: ${sessionId}`)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  send('session', { id: sessionId })
  console.log(`[server] SSE stream opened, sent session event`)

  let client: InstanceType<typeof CopilotClient> | null = null

  try {
    console.log('[server] Creating CopilotClient...')
    client = new CopilotClient({ gitHubToken: token })
    await client.start()
    console.log('[server] CopilotClient started')

    console.log('[server] Creating session...')
    const session = await client.createSession({ hooks: createHooks(send, sessionId, !!body.debug), model })
    console.log('[server] Session created')

    session.on('assistant.message', (event) => {
      const content = event.data.content
      console.log(`[server] Session ${sessionId} ← assistant.message (${content.length} chars): ${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`)
      send('message', { content })
    })

    // Send 'turn-done' when the model goes idle after a message, so the UI
    // knows it can accept user input — but keep the session alive.
    let receivedMessage = false
    session.on('assistant.message', () => { receivedMessage = true })
    session.on('session.idle', () => {
      console.log(`[server] Session ${sessionId} — session.idle (receivedMessage=${receivedMessage})`)
      if (receivedMessage) {
        send('turn-done', { sessionId })
        receivedMessage = false
      }
    })

    const abort = () => {
      console.log(`[server] Session ${sessionId} — abort called`)
      // Resolve any pending step approval so the hook doesn't hang
      const entry = activeSessions.get(sessionId)
      if (entry?.approveStep) {
        entry.approveStep()
        entry.approveStep = null
      }
      session.disconnect().catch(() => {})
      client?.stop().catch(() => {})
      activeSessions.delete(sessionId)
    }

    const sendMessage = async (message: string) => {
      console.log(`[server] Session ${sessionId} — sending follow-up (${message.length} chars)`)
      await session.send({ prompt: message })
    }

    activeSessions.set(sessionId, { abort, send: sendMessage, approveStep: null })

    console.log(`[server] Session ${sessionId} — sending initial prompt to SDK...`)
    await session.send({ prompt: body.prompt })
    console.log(`[server] Session ${sessionId} — prompt sent, session kept alive for follow-ups`)

    // Keep the SSE stream open until the client disconnects or abort is called
    await new Promise<void>((resolve) => {
      req.on('close', () => {
        console.log(`[server] Session ${sessionId} — client disconnected`)
        resolve()
      })
    })

    // Clean up when the stream closes
    activeSessions.delete(sessionId)
    await session.disconnect()
    console.log('[server] Session disconnected')
    await client.stop()
    console.log('[server] Client stopped')
  } catch (err) {
    console.log(`[server] Session ${sessionId} — ERROR:`, err instanceof Error ? err.message : String(err))
    send('error', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    activeSessions.delete(sessionId)
    console.log(`[server] Session ${sessionId} — stream closed`)
    res.end()
  }
}

async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = req.url!.slice('/api/run/'.length).replace('/message', '')
  console.log(`[server] POST /api/run/${id}/message — received`)
  const session = activeSessions.get(id)
  if (!session) {
    console.log(`[server] Session ${id} not found`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session not found' }))
    return
  }

  let body: { message: string }
  try {
    body = JSON.parse(await readBody(req))
    console.log(`[server] Message for session ${id}: ${body.message.length} chars`)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  try {
    await session.send(body.message)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sent: true }))
  } catch (err) {
    console.log(`[server] Session ${id} — send error:`, err instanceof Error ? err.message : String(err))
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
}

function handleStop(req: IncomingMessage, res: ServerResponse): void {
  const id = req.url!.slice('/api/run/'.length)
  console.log(`[server] DELETE /api/run/${id} — stop requested`)
  const session = activeSessions.get(id)
  if (session) {
    session.abort()
    console.log(`[server] Session ${id} stopped`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ stopped: true }))
  } else {
    console.log(`[server] Session ${id} not found`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session not found' }))
  }
}

function handleStep(req: IncomingMessage, res: ServerResponse): void {
  const id = req.url!.slice('/api/run/'.length).replace('/step', '')
  console.log(`[server] POST /api/run/${id}/step — step requested`)
  const session = activeSessions.get(id)
  if (!session) {
    console.log(`[server] Session ${id} not found`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session not found' }))
    return
  }
  if (session.approveStep) {
    session.approveStep()
    session.approveStep = null
    console.log(`[server] Session ${id} — step approved`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ approved: true }))
  } else {
    console.log(`[server] Session ${id} — no pending step`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ approved: false, reason: 'No pending step' }))
  }
}

export function symphonyPlugin(): Plugin {
  return {
    name: 'symphony-orchestrator',
    configureServer(server) {
      console.log('[server] Symphony plugin registered')
      server.middlewares.use((req, res, next) => {
        if (req.method === 'POST' && req.url === '/api/run') {
          handleRun(req, res)
          return
        }
        if (req.method === 'POST' && req.url?.match(/^\/api\/run\/\d+\/message$/)) {
          handleMessage(req, res)
          return
        }
        if (req.method === 'POST' && req.url?.match(/^\/api\/run\/\d+\/step$/)) {
          handleStep(req, res)
          return
        }
        if (req.method === 'DELETE' && req.url?.startsWith('/api/run/')) {
          handleStop(req, res)
          return
        }
        next()
      })
    },
  }
}
