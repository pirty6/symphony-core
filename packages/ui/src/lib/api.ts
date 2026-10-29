import type { Issue, ValidationReport } from '@core/validate'
import type { Complexity, ExecutableScore, Improvisation, Pattern, SavedRun, StateField } from '@core/types'
import type { VisualGraph } from '@core/graph'
import type { NextPerformance, RunMessage } from '../../../../src/runtime/driver'
import type { ProviderEvent } from '../../../../src/runtime/provider'

export type PatternData = Omit<Pattern, 'demo'>

export interface LibraryItem extends PatternData {
  readonly source: 'builtin' | 'extra' | 'draft'
  readonly graph: VisualGraph
  readonly demo?: { readonly goal: string; readonly context: Record<string, unknown> }
}

export interface LiveRun {
  id: string
  pattern: string
  goal: string
  status: string
}

export interface SavedSummary {
  readonly file: string
  readonly pattern: string
  readonly goal: string
  readonly scoreId: string
  readonly outcome: string
  readonly startedAt: string
  readonly steps: number
  /** Played by the offline demo: hidden from the list unless asked for. */
  readonly demo?: boolean
}

export interface ContinueRunRequest {
  readonly file: string
  readonly kind: 'resumed' | 'forked'
  readonly atStep?: number
  readonly provider: string
  readonly model?: string
  readonly autoApprove: boolean
  readonly stepMode: boolean
  readonly breakpoints: readonly string[]
}

export interface StartRunRequest {
  readonly pattern: PatternData
  readonly goal: string
  readonly context: Record<string, unknown>
  readonly provider: 'scripted' | 'copilot'
  readonly model?: string
  readonly autoApprove: boolean
  readonly stepMode: boolean
  readonly breakpoints: string[]
  readonly complexity?: Complexity
  readonly improvisation: Improvisation
  /** Patterns to play after this one, each with what the previous run found. */
  readonly chain?: readonly string[]
}

export type DraftMessage =
  | { type: 'provider'; event: ProviderEvent }
  | { type: 'round'; round: number; errors: string[] }
  | { type: 'done'; pattern?: PatternData; graph?: VisualGraph; rounds: number }
  | { type: 'error'; error: string }

export class ApiError extends Error {
  readonly issues: readonly Issue[]
  constructor(message: string, issues: readonly Issue[] = []) {
    super(message)
    this.issues = issues
  }
}

/** The browser could not reach the studio server at all (stopped, or restarting). */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && /fetch|network|load failed/i.test(e.message)
}

export const SERVER_UNREACHABLE =
  "Could not reach the studio server, so that did not happen. If it restarted (e.g. after a code change), the runs it was playing stopped; open a saved run to resume it."

export const isRunGone = (e: unknown): boolean => e instanceof ApiError && e.message === 'run not found'

/** What to tell the user about a failed request. */
export function errorText(e: unknown): string {
  if (isNetworkError(e)) return SERVER_UNREACHABLE
  if (isRunGone(e)) return RUN_GONE
  return e instanceof Error ? e.message : String(e)
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: Issue[] }
  if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`, body.issues ?? [])
  return body
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  patterns: () => fetch('/api/patterns').then((r) => json<LibraryItem[]>(r)),
  validate: (pattern: PatternData) => post('/api/validate', { pattern }).then((r) => json<ValidationReport>(r)),
  typescript: (pattern: PatternData) => post('/api/typescript', { pattern }).then((r) => json<{ source: string }>(r)),
  savePattern: (pattern: PatternData) => post('/api/patterns', { pattern }).then((r) => json<{ file: string }>(r)),
  startRun: (req: StartRunRequest) => post('/api/runs', req).then((r) => json<{ runId: string; score: ExecutableScore }>(r)),
  /** Resume an interrupted run in place, or fork a saved run from a step (steps before it are kept). */
  continueRun: (req: ContinueRunRequest) => post('/api/runs/continue', req).then((r) => json<{ runId: string; score: ExecutableScore }>(r)),
  control: (runId: string, action: string, extra: Record<string, unknown> = {}) =>
    post(`/api/runs/${runId}/control`, { action, ...extra }).then((r) => json<{ status: string }>(r)),
  /** Answer a stuck AI step: retry (with a hint or another tier) or stop the run. */
  recover: (runId: string, body: { action: 'retry' | 'stop'; hint?: string; complexity?: number }) =>
    post(`/api/runs/${runId}/recovery`, body).then((r) => json<{ ok: boolean }>(r)),
  approve: (runId: string, body: { approved: boolean; updates?: Record<string, unknown>; scripted?: boolean }) =>
    post(`/api/runs/${runId}/approval`, body).then((r) => json<{ ok: boolean }>(r)),
  saved: () => fetch('/api/saved').then((r) => json<SavedSummary[]>(r)),
  /** Runs this server started (live and finished), newest first. */
  liveRuns: () => fetch('/api/runs').then((r) => json<LiveRun[]>(r)),
  /** Retention: delete old demo runs, compact old runs (dryRun only reports). */
  prune: (dryRun: boolean) =>
    post('/api/saved/prune', { dryRun }).then((r) =>
      json<{ deleted: string[]; compacted: string[]; scratch: string[]; freed: number }>(r),
    ),
  run: (runId: string) =>
    fetch(`/api/runs/${runId}`).then((r) => json<{ id: string; status: string; score: ExecutableScore; graph: VisualGraph }>(r)),
  /** Whether Copilot can run here (a GitHub account is signed in), and how to fix it if not. */
  copilotStatus: () =>
    fetch('/api/copilot/status').then((r) => json<{ signedIn: boolean; login?: string; message: string }>(r)),
  tiers: () => fetch('/api/tiers').then((r) => json<Record<Complexity, { model: string; effort?: string }>>(r)),
  /** Delete one saved run (refused while it is still playing). */
  deleteSaved: (file: string) => post('/api/saved/delete', { path: file }).then((r) => json<{ deleted: string }>(r)),
  savedFile: (file: string) =>
    fetch(`/api/saved/file?path=${encodeURIComponent(file)}`).then((r) =>
      json<{ run: SavedRun; issues: string[]; reproduced: boolean; graph: VisualGraph }>(r),
    ),
}

export const TERMINAL = new Set(['done', 'failed', 'cancelled'])

export const RUN_GONE = 'That run is no longer on the server (it restarted). Open its saved run to resume it.'

/**
 * Subscribe to a run. EventSource resumes from the last seq on reconnect; closes
 * at the end. When the connection drops and the server no longer has the run
 * (it restarted), onLost is called once and the subscription closes.
 */
export function subscribeRun(runId: string, onMessage: (m: RunMessage) => void, onLost?: () => void): () => void {
  const source = new EventSource(`/api/runs/${runId}/events`)
  source.onmessage = (e: MessageEvent<string>) => {
    const m = JSON.parse(e.data) as RunMessage
    onMessage(m)
    if (m.type === 'status' && TERMINAL.has(m.status)) source.close()
  }
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED || !onLost) return
    void fetch(`/api/runs/${runId}`).then(
      (r) => {
        if (r.status !== 404 || source.readyState === EventSource.CLOSED) return
        source.close()
        onLost()
      },
      () => undefined, // Unreachable: EventSource keeps retrying.
    )
  }
  return () => source.close()
}

/** Stream an AI draft (POST + SSE body). */
export async function streamDraft(
  body: { request: string; provider: 'scripted' | 'copilot'; model?: string; priorDraft?: unknown; feedback?: string[] },
  onMessage: (m: DraftMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok || !res.body) throw new ApiError(`draft failed: HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf
        .slice(0, i)
        .split('\n')
        .find((l) => l.startsWith('data: '))
      buf = buf.slice(i + 2)
      if (line) onMessage(JSON.parse(line.slice(6)) as DraftMessage)
    }
  }
}

export type { NextPerformance, RunMessage, ProviderEvent, StateField }
