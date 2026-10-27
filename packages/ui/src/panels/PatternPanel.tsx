import { useState } from 'react'
import { FIELD_TYPES, type FieldType, type StateField } from '@core/types'
import type { Issue } from '@core/validate'
import type { PatternMeta } from '../lib/model'

interface Props {
  meta: PatternMeta
  editable: boolean
  goal: string
  context: Record<string, string>
  errors: readonly Issue[]
  warnings: readonly Issue[]
  onMeta: (m: PatternMeta) => void
  onGoal: (g: string) => void
  onContext: (c: Record<string, string>) => void
  onSelect: (id: string) => void
  onExport: () => Promise<string>
  onSave: () => Promise<string>
}

export function PatternPanel(p: Props) {
  const [output, setOutput] = useState<string>('')
  const [newField, setNewField] = useState<{ name: string; type: FieldType }>({ name: '', type: 'string' })
  const m = p.meta
  const set = (patch: Partial<PatternMeta>) => p.onMeta({ ...m, ...patch })
  // Required inputs and tunable settings (fields with an initial value) first; working state folded away.
  const isPrimary = (f: StateField) => m.requiredContext.includes(f.name) || f.initial !== undefined || (p.context[f.name] ?? '') !== ''
  const primary = m.state.filter(isPrimary).sort((a, b) => Number(b.name === m.goalFrom) - Number(a.name === m.goalFrom))
  const secondary = m.state.filter((f) => !isPrimary(f))
  const field = (f: StateField) => (
    <label key={f.name} className="field">
      {f.name}{' '}
      <small>
        ({f.type}){m.requiredContext.includes(f.name) ? ' · required' : ''}
        {f.name === m.goalFrom ? ' · the goal' : ''}
      </small>
      <input
        value={p.context[f.name] ?? ''}
        placeholder={f.description ?? (f.initial !== undefined ? `initial ${JSON.stringify(f.initial)}` : '')}
        onChange={(e) => p.onContext({ ...p.context, [f.name]: e.target.value })}
        aria-label={`context ${f.name}`}
      />
    </label>
  )

  return (
    <div className="pattern-panel">
      <section>
        <h3>Run inputs</h3>
        {!m.goalFrom && (
          <label className="field">
            Goal
            <textarea rows={2} value={p.goal} onChange={(e) => p.onGoal(e.target.value)} aria-label="goal" />
          </label>
        )}
        {primary.map(field)}
        {secondary.length > 0 && (
          <details>
            <summary className="muted">Other initial state ({secondary.length})</summary>
            {secondary.map(field)}
          </details>
        )}
      </section>

      <section>
        <h3>Problems</h3>
        {p.errors.length === 0 && p.warnings.length === 0 && <p className="ok">✓ Valid: every path is bounded and checked.</p>}
        {[...p.errors.map((e) => ({ ...e, level: 'error' })), ...p.warnings.map((w) => ({ ...w, level: 'warning' }))].map((i, k) => (
          <button
            type="button"
            key={k}
            className={`issue ${i.level}`}
            onClick={() => (i.nodeId || i.edgeId) && p.onSelect((i.nodeId ?? i.edgeId)!)}
            data-testid={`issue-${i.level}`}
          >
            {i.level === 'error' ? '✘' : '⚠'} {i.message}
          </button>
        ))}
      </section>

      <section>
        <h3>Pattern</h3>
        <fieldset className="editor" disabled={!p.editable}>
          <label className="field">
            Name
            <input value={m.name} onChange={(e) => set({ name: e.target.value })} aria-label="pattern name" />
          </label>
          <label className="field">
            Description
            <input value={m.description} onChange={(e) => set({ description: e.target.value })} aria-label="pattern description" />
          </label>
          <label className="field" title="A required text input that states what the run is for. Without one, runs ask for a separate goal.">
            Goal input
            <select value={m.goalFrom ?? ''} onChange={(e) => set({ goalFrom: e.target.value || undefined })} aria-label="goal input">
              <option value="">none: ask for a separate goal</option>
              {m.state
                .filter((f) => f.type === 'string' && m.requiredContext.includes(f.name))
                .map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            Max steps
            <input type="number" min={1} value={m.maxSteps ?? 100} onChange={(e) => set({ maxSteps: Number(e.target.value) || undefined })} aria-label="max steps" />
          </label>
          <h4>State</h4>
          <table className="fields">
            <tbody>
              {m.state.map((f, i) => (
                <tr key={f.name}>
                  <td>
                    <code>{f.name}</code>
                  </td>
                  <td>{f.type}</td>
                  <td>
                    <label title="Required at run start">
                      <input
                        type="checkbox"
                        checked={m.requiredContext.includes(f.name)}
                        onChange={(e) =>
                          set({
                            requiredContext: e.target.checked
                              ? [...m.requiredContext, f.name]
                              : m.requiredContext.filter((k) => k !== f.name),
                            ...(!e.target.checked && f.name === m.goalFrom ? { goalFrom: undefined } : {}),
                          })
                        }
                      />
                      req
                    </label>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      aria-label={`remove ${f.name}`}
                      onClick={() =>
                        set({ state: m.state.filter((_, j) => j !== i), requiredContext: m.requiredContext.filter((k) => k !== f.name) })
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <input placeholder="field" value={newField.name} onChange={(e) => setNewField({ ...newField, name: e.target.value })} aria-label="new field name" />
            <select value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value as FieldType })} aria-label="new field type">
              {FIELD_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!newField.name.trim() || m.state.some((f) => f.name === newField.name.trim())}
              onClick={() => {
                set({ state: [...m.state, { name: newField.name.trim(), type: newField.type }] })
                setNewField({ name: '', type: 'string' })
              }}
            >
              Add
            </button>
          </div>
        </fieldset>
      </section>

      <section>
        <h3>Export</h3>
        <div className="row">
          <button type="button" disabled={p.errors.length > 0} onClick={() => void p.onExport().then(setOutput, (e: Error) => setOutput(e.message))}>
            View TypeScript
          </button>
          <button
            type="button"
            disabled={p.errors.length > 0}
            onClick={() => void p.onSave().then((f) => setOutput(`Saved ${f}`), (e: Error) => setOutput(e.message))}
          >
            Save to library
          </button>
        </div>
        {output && <pre className="json ts-output">{output}</pre>}
      </section>
    </div>
  )
}
