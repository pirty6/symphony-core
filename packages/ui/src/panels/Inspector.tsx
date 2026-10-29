import { useEffect, useRef, useState } from 'react'
import type { Frame } from '@core/replay'
import { parseFieldInput } from '@core/schema'
import type { ScoreEdge, ScoreNode, StateField } from '@core/types'
import type { AiStream, FlowEdge, FlowNode, RunView } from '../lib/model'

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

const json = (v: unknown) => JSON.stringify(v, null, 2)

/** Built-in tools and their outputs (mirrors src/runtime/builtin-tools.ts). */
const TOOL_OUTPUTS: Record<string, string[]> = {
  'repo.files': ['files', 'excluded'],
  'sources.catalog': ['names', 'descriptions'],
}

// ── cards shown while a run waits for the user ─────────────────────

export function GateCard({ view, onResume, onStep, onStop }: { view: RunView; onResume: () => void; onStep: () => void; onStop: () => void }) {
  if (view.status !== 'paused' || !view.gate) return null
  const { gate } = view
  return (
    <div className="card gate" data-testid="gate-card">
      <h3>
        ⏸ Paused {gate.phase === 'before' ? 'before' : view.pause?.kind === 'tool' ? 'after the tool ran at' : 'after AI answered at'} “{gate.nodeId}”
      </h3>
      {gate.phase === 'before' ? (
        <p className="muted">Nothing has run yet for this node. Inspect its input below, then continue.</p>
      ) : (
        <>
          <p className="muted">The engine has not applied this yet. It will be validated against the node's schema.</p>
          <pre className="json" data-testid="proposed-result">
            {json(gate.proposed)}
          </pre>
        </>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={onResume}>
          ▶ Resume
        </button>
        <button type="button" onClick={onStep}>
          ⏭ Step
        </button>
        <button type="button" className="danger" onClick={onStop}>
          ⏹ Stop
        </button>
      </div>
    </div>
  )
}

export interface RecoveryAnswer {
  action: 'retry' | 'stop'
  hint?: string
  complexity?: number
}

/** A stuck AI step (out of attempts): what went wrong, then retry it or stop the run. */
export function RecoveryCard({ view, onAnswer }: { view: RunView; onAnswer: (a: RecoveryAnswer) => Promise<unknown> | void }) {
  const pause = view.pause
  const [hint, setHint] = useState('')
  const [tier, setTier] = useState(0)
  const [sentFor, setSentFor] = useState<string | undefined>()
  const pauseId = pause?.pauseId
  useEffect(() => {
    setHint('')
    setTier(0)
  }, [pauseId])
  if (view.status !== 'awaiting-approval' || pause?.kind !== 'stuck') return null
  const sent = sentFor === pause.pauseId
  const answer = (a: RecoveryAnswer) => {
    setSentFor(pause.pauseId)
    // If the answer does not get through, open the card again so it can be sent again.
    void Promise.resolve(onAnswer(a)).catch(() => setSentFor(undefined))
  }
  return (
    <form
      className="card approval stuck"
      data-testid="recovery-card"
      onSubmit={(e) => {
        e.preventDefault()
        answer({ action: 'retry', ...(hint.trim() ? { hint: hint.trim() } : {}), ...(tier ? { complexity: tier } : {}) })
      }}
    >
      <h3>⚠ {pause.label} is stuck</h3>
      <p>
        No valid answer in {pause.attempts} attempts (tier {pause.complexity}). The run is waiting: retry this step, or stop the run. The AI
        output tab shows what it tried.
      </p>
      <ul className="stuck-feedback">
        {pause.feedback.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
      <fieldset className="editor" disabled={sent}>
        <label className="field">
          Hint for the AI (optional)
          <textarea
            rows={2}
            value={hint}
            placeholder="e.g. the page is rate-limited: report it as unreadable"
            onChange={(e) => setHint(e.target.value)}
            aria-label="recovery hint"
          />
        </label>
        <label className="field">
          Model for the retry
          <select value={tier} onChange={(e) => setTier(Number(e.target.value))} aria-label="recovery tier">
            <option value={0}>same (tier {pause.complexity})</option>
            {[1, 2, 3, 4]
              .filter((t) => t !== pause.complexity)
              .map((t) => (
                <option key={t} value={t}>
                  tier {t}
                  {t > pause.complexity ? ' (smarter)' : ''}
                </option>
              ))}
          </select>
        </label>
        <div className="row">
          <button type="submit" className="primary">
            ↻ Retry step
          </button>
          <button type="button" onClick={() => answer({ action: 'stop' })}>
            ✕ Stop run
          </button>
        </div>
      </fieldset>
    </form>
  )
}

export function ApprovalCard({
  view,
  onAnswer,
}: {
  view: RunView
  onAnswer: (a: { approved: boolean; updates?: Record<string, unknown>; scripted?: boolean }) => Promise<unknown> | void
}) {
  const pause = view.pause
  const [values, setValues] = useState<Record<string, string>>({})
  const [sentFor, setSentFor] = useState<string | undefined>()
  const pauseId = pause?.pauseId
  useEffect(() => setValues({}), [pauseId])
  if (view.status !== 'awaiting-approval' || pause?.kind !== 'approval') return null
  const sent = sentFor === pause.pauseId
  const answer = (a: { approved: boolean; updates?: Record<string, unknown>; scripted?: boolean }) => {
    setSentFor(pause.pauseId)
    // If the answer does not get through, open the card again so it can be sent again.
    void Promise.resolve(onAnswer(a)).catch(() => setSentFor(undefined))
  }
  const submit = (approved: boolean) => {
    try {
      const updates = Object.fromEntries(pause.outputSchema.map((f) => [f.name, parseFieldInput(f.type, values[f.name] ?? '')]))
      answer({ approved, updates })
    } catch (e) {
      alert((e as Error).message)
    }
  }
  return (
    <form
      className="card approval"
      data-testid="approval-card"
      data-pause-id={pause.pauseId}
      onSubmit={(e) => {
        e.preventDefault()
        submit(true)
      }}
    >
      <h3>✋ {pause.label}</h3>
      <p>{pause.message}</p>
      <ComposedScore state={pause.state} />
      <Shown keys={pause.shows ?? []} state={pause.state} />
      <fieldset className="editor" disabled={sent}>
      {pause.feedback?.map((f, i) => (
        <div key={i} className="issue">
          {f}
        </div>
      ))}
      {pause.outputSchema.map((f) => (
        <label key={f.name} className="field">
          {f.name} <small>({f.type})</small>
          <input
            autoFocus
            placeholder={f.description ?? ''}
            value={values[f.name] ?? ''}
            onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            aria-label={f.name}
          />
        </label>
      ))}
      <div className="row">
        <button type="submit" className="primary">
          Approve
        </button>
        <button type="button" onClick={() => submit(false)}>
          Reject
        </button>
        <button type="button" onClick={() => answer({ approved: true, scripted: true })} title="Use the pattern's demo answer">
          Scripted answer
        </button>
      </div>
      </fieldset>
    </form>
  )
}

// ── AI output ──────────────────────────────────────────────────────

export function AiOutput({ stream, live }: { stream: AiStream | undefined; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [stream?.text, live])
  if (!stream) return <p className="muted">No AI output for this node yet. Agent nodes stream here while they run.</p>
  return (
    <div className="ai-output" data-testid="ai-output">
      <div className="muted">
        step {stream.step} · attempt {stream.attempt}
        {stream.info.length > 0 && ` · ${stream.info.filter((i) => !i.startsWith('running')).join(' · ')}`}
      </div>
      {stream.permissions.filter((p) => !p.allowed).map((p, i) => (
        <div key={i} className="issue">
          ⛔ {p.detail}
        </div>
      ))}
      {stream.tools.length > 0 && (
        <ul className="tools">
          {stream.tools.map((t) => (
            <li key={t.id} className={t.ok === false || t.denied ? 'bad' : ''}>
              ⚙ {t.name} {t.ok === undefined && !t.denied ? '…' : t.ok ? '✓' : '✗'}
            </li>
          ))}
        </ul>
      )}
      {stream.reasoning && (
        <details>
          <summary>reasoning</summary>
          <pre className="stream">{stream.reasoning}</pre>
        </details>
      )}
      <pre className="stream" ref={ref} data-testid="ai-text">
        {stream.text || stream.messages.join('\n') || stream.info.join('\n') || '…'}
      </pre>
      {stream.rejected && (
        <div className="issue">
          Response rejected by the engine:
          <ul>
            {stream.rejected.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {stream.result !== undefined && (
        <>
          <h4>Submitted result</h4>
          <pre className="json">{json(stream.result)}</pre>
        </>
      )}
    </div>
  )
}

export function AiTakes({ streams, live }: { streams: readonly AiStream[]; live: boolean }) {
  if (streams.length <= 1) return <AiOutput stream={streams[0]} live={live} />
  return (
    <div className="takes" data-testid="ai-takes">
      {streams.map((s) => (
        <details key={s.key} open={s.take === 0} className={s.take === 0 ? 'take merge' : 'take'}>
          <summary>{s.take === 0 ? '🎺 Bandleader: merged answer' : `Take ${s.take}`}</summary>
          <AiOutput stream={s} live={live} />
        </details>
      ))}
    </div>
  )
}

/** Summary of the score the maestro composed, shown at its go-gate. */
/** The state an approval asks the human to look at before deciding. */
function Shown({ keys, state }: { keys: readonly string[]; state: Readonly<Record<string, unknown>> }) {
  if (keys.length === 0) return null
  return (
    <div className="shown" data-testid="approval-shows">
      {keys.map((k) => {
        const v = state[k]
        return (
          <div key={k}>
            <b>{k}</b>
            {Array.isArray(v) && v.every((x) => typeof x === 'string') ? (
              <ol>
                {v.map((x, i) => (
                  <li key={i}>
                    <code>{x}</code>
                  </li>
                ))}
              </ol>
            ) : (
              <pre className="json">{json(v)}</pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** How the maestro tailored a tested library pattern: guidance per step, changed settings. */
function Tailoring({ adaptation }: { adaptation: unknown }) {
  const a = (adaptation ?? {}) as { directives?: Record<string, string>; initial?: Record<string, unknown> }
  const guidance = Object.entries(a.directives ?? {})
  const settings = Object.entries(a.initial ?? {})
  if (guidance.length === 0 && settings.length === 0) return null
  return (
    <div className="tailoring" data-testid="tailoring">
      <div className="muted">Tailored for this request (the steps above are the tested pattern):</div>
      <ul>
        {guidance.map(([step, text]) => (
          <li key={step}>
            <b>{step}</b>: {text}
          </li>
        ))}
        {settings.map(([k, x]) => (
          <li key={k}>
            <code>{k}</code> = {JSON.stringify(x)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ComposedScore({ state }: { state: Readonly<Record<string, unknown>> }) {
  const p = state.normalized as { name?: string; description?: string; nodes?: { id: string; label: string; kind: string; role?: string }[] } | undefined
  if (!p?.nodes) return null
  const notes = (state.debateNotes as string[] | undefined) ?? []
  const missing = (state.contextNotes as string[] | undefined) ?? []
  return (
    <div className="composed" data-testid="composed-score">
      <div>
        <b>{p.name}</b> · complexity {String(state.complexity)} · round {String(state.round)}
        {state.chosen === 'new' ? ' · new pattern' : ''}
      </div>
      <p className="muted">{p.description}</p>
      <ol className="composed-steps">
        {p.nodes
          .filter((n) => n.kind !== 'start')
          .map((n) => (
            <li key={n.id}>
              {n.label} <small className="muted">{n.kind === 'agent' ? n.role : n.kind}</small>
            </li>
          ))}
      </ol>
      <Tailoring adaptation={state.adaptation} />
      {notes.length > 0 && (
        <ul className="debate-notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <div className="muted">inputs {JSON.stringify(state.childContext ?? {})}</div>
      {missing.map((m, i) => (
        <div key={i} className="issue warning">
          {m}
        </div>
      ))}
    </div>
  )
}

// ── state ──────────────────────────────────────────────────────────

export function StateView({ frame }: { frame: Frame }) {
  const changed = new Map(frame.lastChanges.map((c) => [c.key, c]))
  const keys = Object.keys(frame.state)
  if (keys.length === 0) return <p className="muted">State appears here once a run starts.</p>
  return (
    <div className="state-view" data-testid="state-view">
      {frame.lastEdge && frame.event?.type === 'edge-taken' && (
        <div className="card edge-data">
          <b>Data on edge {frame.lastEdge.id}</b>
          <pre className="json">{json(frame.lastEdge.values)}</pre>
        </div>
      )}
      <table>
        <tbody>
          {keys.map((k) => {
            const c = changed.get(k)
            return (
              <tr key={k} className={c ? 'changed' : ''} data-testid={`state-${k}`}>
                <th>{k}</th>
                <td>
                  {c && <s className="before">{JSON.stringify(c.before)}</s>}
                  <code>{JSON.stringify(frame.state[k])}</code>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── editors ────────────────────────────────────────────────────────

export function NodeEditor({
  node,
  state,
  editable,
  onChange,
  onDelete,
}: {
  node: FlowNode
  state: readonly StateField[]
  editable: boolean
  onChange: (n: ScoreNode) => void
  onDelete: () => void
}) {
  const n = node.data.node
  const set = (patch: Partial<ScoreNode>) => onChange({ ...n, ...patch } as ScoreNode)
  const fields = state.map((f) => f.name).join(', ')
  return (
    <fieldset className="editor" disabled={!editable}>
      <label className="field">
        Label
        <input value={n.label} onChange={(e) => set({ label: e.target.value })} aria-label="label" />
      </label>
      {n.kind === 'agent' && (
        <>
          <label className="field">
            Role
            <select value={n.role} onChange={(e) => set({ role: e.target.value as 'assessor' | 'executor' })} aria-label="role">
              <option value="assessor">assessor (read-only)</option>
              <option value="executor">executor (read-write)</option>
            </select>
          </label>
          <label className="field">
            Directive
            <textarea rows={4} value={n.directive} onChange={(e) => set({ directive: e.target.value })} aria-label="directive" />
          </label>
          <label className="field">
            Reads <small>(comma separated: {fields || 'define state first'})</small>
            <input value={n.reads.join(', ')} onChange={(e) => set({ reads: list(e.target.value) })} aria-label="reads" />
          </label>
          <label className="field">
            Writes
            <input value={n.writes.join(', ')} onChange={(e) => set({ writes: list(e.target.value) })} aria-label="writes" />
          </label>
        </>
      )}
      {n.kind === 'agent' && (
        <>
          <div className="field">
            Extra sources
            <div className="row">
              {(['web', 'mcp'] as const).map((cap) => (
                <label key={cap}>
                  <input
                    type="checkbox"
                    checked={n.capabilities?.includes(cap) ?? false}
                    onChange={(e) => {
                      const caps = new Set(n.capabilities ?? [])
                      if (e.target.checked) caps.add(cap)
                      else caps.delete(cap)
                      const { capabilities: _c, ...rest } = n
                      onChange((caps.size ? { ...rest, capabilities: [...caps] } : rest) as ScoreNode)
                    }}
                    aria-label={`capability ${cap}`}
                  />
                  {cap === 'web' ? 'web search + fetch' : 'MCP servers'}
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            Acceptance checks <small>(one per line: expression | message shown to the AI when it fails)</small>
            <textarea
              rows={3}
              value={(n.checks ?? []).map((c) => `${c.expr} | ${c.message}`).join('\n')}
              onChange={(e) => {
                const checks = e.target.value
                  .split('\n')
                  .filter((l) => l.trim())
                  .map((l) => {
                    const i = l.indexOf('|')
                    return i === -1 ? { expr: l.trim(), message: '' } : { expr: l.slice(0, i).trim(), message: l.slice(i + 1).trim() }
                  })
                const { checks: _c, ...rest } = n
                onChange((checks.length ? { ...rest, checks } : rest) as ScoreNode)
              }}
              aria-label="checks"
            />
          </label>
        </>
      )}
      {n.kind === 'tool' && (
        <>
          <label className="field">
            Tool
            <select value={n.tool} onChange={(e) => set({ tool: e.target.value })} aria-label="tool">
              {Object.keys(TOOL_OUTPUTS).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Output <small>(one per line: tool output = state field; outputs: {(TOOL_OUTPUTS[n.tool] ?? []).join(', ')})</small>
            <textarea
              rows={3}
              value={Object.entries(n.output)
                .map(([k, f]) => `${k} = ${f}`)
                .join('\n')}
              onChange={(e) =>
                set({
                  output: Object.fromEntries(
                    e.target.value
                      .split('\n')
                      .filter((l) => l.includes('='))
                      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
                  ),
                })
              }
              aria-label="tool output"
            />
          </label>
        </>
      )}
      {n.kind === 'compute' && (
        <label className="field">
          Assignments <small>(one per line: field = expression)</small>
          <textarea
            rows={4}
            value={n.assign.map((a) => `${a.field} = ${a.expr}`).join('\n')}
            onChange={(e) =>
              set({
                assign: e.target.value
                  .split('\n')
                  .filter((l) => l.includes('='))
                  .map((l) => ({ field: l.slice(0, l.indexOf('=')).trim(), expr: l.slice(l.indexOf('=') + 1).trim() })),
              })
            }
            aria-label="assignments"
          />
        </label>
      )}
      {n.kind === 'condition' && (
        <label className="field">
          Expression <small>(e.g. confidence &gt;= 0.7)</small>
          <input value={n.expression} onChange={(e) => set({ expression: e.target.value })} aria-label="expression" />
        </label>
      )}
      {n.kind === 'approval' && (
        <>
          <label className="field">
            Message
            <textarea rows={2} value={n.message} onChange={(e) => set({ message: e.target.value })} aria-label="message" />
          </label>
          <label className="field">
            Human provides <small>(state keys)</small>
            <input value={n.writes.join(', ')} onChange={(e) => set({ writes: list(e.target.value) })} aria-label="writes" />
          </label>
        </>
      )}
      {n.kind === 'end' && (
        <label className="field">
          Outcome
          <select value={n.outcome ?? 'success'} onChange={(e) => set({ outcome: e.target.value as 'success' | 'failed' | 'partial' })} aria-label="outcome">
            <option value="success">success</option>
            <option value="partial">partial</option>
            <option value="failed">failed</option>
          </select>
        </label>
      )}
      {n.kind !== 'start' && n.kind !== 'end' && (
        <label className="field">
          Max visits <small>(loop bound)</small>
          <input
            type="number"
            min={1}
            value={n.maxVisits ?? ''}
            onChange={(e) => {
              const { maxVisits: _m, ...rest } = n
              onChange((e.target.value ? { ...rest, maxVisits: Number(e.target.value) } : rest) as ScoreNode)
            }}
            aria-label="max visits"
          />
        </label>
      )}
      {editable && (
        <button type="button" className="danger" onClick={onDelete}>
          Delete node
        </button>
      )}
    </fieldset>
  )
}

export function EdgeEditor({
  edge,
  editable,
  onChange,
  onDelete,
}: {
  edge: FlowEdge
  editable: boolean
  onChange: (e: ScoreEdge) => void
  onDelete: () => void
}) {
  const e = edge.data!.edge
  return (
    <fieldset className="editor" disabled={!editable}>
      <p className="muted">
        {edge.source} → {edge.target}
        {e.branch ? ` [${e.branch}]` : ''}
      </p>
      {e.branch !== 'then' && e.branch !== 'else' && (
        <label className="field">
          Guard <small>(empty = default edge; tried in order)</small>
          <input
            value={e.guard ?? ''}
            onChange={(ev) => {
              const { guard: _g, ...rest } = e
              onChange(ev.target.value.trim() ? { ...rest, guard: ev.target.value } : rest)
            }}
            aria-label="guard"
          />
        </label>
      )}
      <label className="field">
        Label
        <input
          value={e.label ?? ''}
          onChange={(ev) => {
            const { label: _l, ...rest } = e
            onChange(ev.target.value ? { ...rest, label: ev.target.value } : rest)
          }}
          aria-label="edge label"
        />
      </label>
      <p className="muted">Carries: {edge.data!.carries.join(', ') || 'nothing'}</p>
      {editable && (
        <button type="button" className="danger" onClick={onDelete}>
          Delete edge
        </button>
      )}
    </fieldset>
  )
}

export function NodeInput({ node, frame }: { node: FlowNode; frame: Frame }) {
  const reads = node.data.reads
  if (reads.length === 0) return null
  return (
    <div className="node-input">
      <h4>Input it sees</h4>
      <pre className="json">{json(Object.fromEntries(reads.map((k) => [k, frame.state[k]])))}</pre>
    </div>
  )
}

