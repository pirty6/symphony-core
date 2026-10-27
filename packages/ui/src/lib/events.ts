import type { EngineEvent } from '@core/types'

/** One-line, human-readable description of an engine event. */
export function describeEvent(e: EngineEvent): string {
  switch (e.type) {
    case 'run-started':
      return 'run started'
    case 'node-entered':
      return `#${e.step} enter ${e.nodeId}`
    case 'guard-evaluated':
      return `${e.expression} → ${e.result}`
    case 'edge-taken':
      return `${e.from} → ${e.to}${e.carried.length ? ` (${e.carried.join(', ')})` : ''}`
    case 'paused':
      return `${e.pause.kind === 'agent' ? 'AI' : 'human'} needed at ${e.pause.nodeId}${e.pause.kind === 'agent' && e.pause.attempt > 1 ? ` (attempt ${e.pause.attempt})` : ''}`
    case 'response-rejected':
      return `rejected ${e.nodeId}: ${e.errors[0] ?? ''}`
    case 'node-completed':
      return `${e.nodeId} ${e.changes.length ? `changed ${e.changes.map((c) => c.key).join(', ')}` : 'done'}`
    case 'run-completed':
      return `${e.outcome}: ${e.reason}`
    case 'run-failed':
      return `failed: ${e.error}`
  }
}
