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

// ── cards shown while a run waits for the user ─────────────────────

export function GateCard({ view, onResume, onStep, onStop }: { view: RunView; onResume: () => void; onStep: () => void; onStop: () => void }) {
  if (view.status !== 'paused' || !view.gate) return null
  const { gate } = view
  return (
    <div className="card gate" data-testid="gate-card">
      <h3>⏸ Paused {gate.phase === 'before' ? 'before' : 'after AI answered at'} “{gate.nodeId}”</h3>
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

export function ApprovalCard({
  view,
  onAnswer,
}: {
  view: RunView
  onAnswer: (a: { approved: boolean; updates?: Record<string, unknown>; scripted?: boolean }) => void
}) {
  const pause = view.pause
  const [values, setValues] = useState<Record<string, string>>({})
  const pauseId = pause?.pauseId
  useEffect(() => setValues({}), [pauseId])
  if (view.status !== 'awaiting-approval' || pause?.kind !== 'approval') return null
  const submit = (approved: boolean) => {
    try {
      const updates = Object.fromEntries(pause.outputSchema.map((f) => [f.name, parseFieldInput(f.type, values[f.name] ?? '')]))
      onAnswer({ approved, updates })
    } catch (e) {
      alert((e as Error).message)
    }
  }
  return (
    <form
      className="card approval"
      data-testid="approval-card"
      onSubmit={(e) => {
        e.preventDefault()
        submit(true)
      }}
    >
      <h3>✋ {pause.label}</h3>
      <p>{pause.message}</p>
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
        <button type="button" onClick={() => onAnswer({ approved: true, scripted: true })} title="Use the pattern's demo answer">
          Scripted answer
        </button>
      </div>
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
        {stream.info.length > 0 && ` · ${stream.info.at(-1)}`}
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
        {stream.text || stream.messages.join('\n') || '…'}
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

