import { useState, type DragEvent } from 'react'
import type { LibraryItem, SavedSummary } from '../lib/api'
import type { PaletteKind } from '../lib/model'

const PALETTE: { kind: PaletteKind; icon: string; label: string; hint: string }[] = [
  { kind: 'assessor', icon: '🔍', label: 'Assessor', hint: 'AI, read-only' },
  { kind: 'executor', icon: '⚡', label: 'Executor', hint: 'AI, read-write' },
  { kind: 'compute', icon: 'ƒ', label: 'Compute', hint: 'set state in code' },
  { kind: 'condition', icon: '◆', label: 'If', hint: 'branch on state' },
  { kind: 'approval', icon: '✋', label: 'Approval', hint: 'human gate' },
  { kind: 'end', icon: '⏹', label: 'End', hint: 'finish' },
  { kind: 'tool', icon: '⚙', label: 'Tool', hint: 'deterministic I/O' },
  { kind: 'start', icon: '▶', label: 'Start', hint: 'entry (one)' },
]

interface Props {
  library: readonly LibraryItem[]
  activeName: string
  saved: readonly SavedSummary[]
  editable: boolean
  drafting: { busy: boolean; text: string; errors: string[] }
  onLoad: (item: LibraryItem) => void
  onNew: () => void
  onOpenSaved: (file: string) => void
  onRefreshSaved: () => void
  onDraft: (request: string) => void
}

export function Library(p: Props) {
  const [request, setRequest] = useState('')
  const onDragStart = (e: DragEvent, kind: PaletteKind) => {
    e.dataTransfer.setData('application/symphony-node', kind)
    e.dataTransfer.effectAllowed = 'move'
  }
  return (
    <aside className="library">
      <section>
        <h2>Patterns</h2>
        {p.library.map((item) => (
          <button
            type="button"
            key={item.name}
            className={`lib-item${item.name === p.activeName ? ' active' : ''}`}
            onClick={() => p.onLoad(item)}
            title={item.description}
          >
            <b>{item.name}</b>
            {item.source === 'draft' && <span className="tag">draft</span>}
            <small>{item.description}</small>
          </button>
        ))}
        <button type="button" className="lib-new" onClick={p.onNew}>
          + Blank pattern
        </button>
      </section>

      <section>
        <h2>Draft with AI</h2>
        <textarea
          className="draft-input"
          placeholder="Describe the flow, e.g. “triage a failing CI job and propose a fix”"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          aria-label="draft request"
        />
        <button type="button" className="primary" disabled={p.drafting.busy || !request.trim()} onClick={() => p.onDraft(request)}>
          {p.drafting.busy ? 'Drafting…' : '✨ Draft flow'}
        </button>
        {(p.drafting.text || p.drafting.errors.length > 0) && (
          <div className="draft-stream" data-testid="draft-stream">
            <pre>{p.drafting.text}</pre>
            {p.drafting.errors.map((e, i) => (
              <div key={i} className="issue">
                {e}
              </div>
            ))}
          </div>
        )}
      </section>

      {p.editable && (
        <section>
          <h2>Add node (drag)</h2>
          <div className="palette">
            {PALETTE.map((item) => (
              <div
                key={item.kind}
                className={`palette-item kind-${item.kind}`}
                draggable
                onDragStart={(e) => onDragStart(e, item.kind)}
                title={item.hint}
                data-testid={`palette-${item.kind}`}
              >
                <span>{item.icon}</span> {item.label}
                <small>{item.hint}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>
          Saved runs
          <button type="button" className="link" onClick={p.onRefreshSaved} title="Refresh">
            ↻
          </button>
        </h2>
        {p.saved.length === 0 && <small className="muted">Runs are saved to .symphony/runs</small>}
        {p.saved.slice(0, 30).map((r) => (
          <button type="button" key={r.file} className="lib-item saved" onClick={() => p.onOpenSaved(r.file)} title={r.goal}>
            <b>{r.pattern}</b> <span className={`tag outcome-${r.outcome}`}>{r.outcome}</span>
            <small>
              {new Date(r.startedAt).toLocaleString()} · {r.steps} steps
            </small>
          </button>
        ))}
      </section>
    </aside>
  )
}
