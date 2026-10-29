import { useState, type DragEvent } from 'react'
import { TERMINAL, type LibraryItem, type LiveRun, type SavedSummary } from '../lib/api'
import type { PaletteKind } from '../lib/model'
import { PromptBox } from './PromptBox'

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
  /** Runs the server is playing; the one on screen is `liveId`. */
  live?: readonly LiveRun[]
  liveId?: string | undefined
  onOpenLive?: (id: string) => void
  editable: boolean
  asking: boolean
  onLoad: (item: LibraryItem) => void
  onNew: () => void
  onOpenSaved: (file: string) => void
  onRefreshSaved: () => void
  onPrune: () => void
  /** Delete one saved run; resolves once it is gone. */
  onDeleteSaved?: (file: string) => Promise<void>
  onAsk: (request: string) => void
}

export function Library(p: Props) {
  const [request, setRequest] = useState('')
  const [showDemo, setShowDemo] = useState(false)
  /** The saved run whose delete is waiting for a second click. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const demoCount = p.saved.filter((r) => r.demo).length
  const saved = showDemo ? p.saved : p.saved.filter((r) => !r.demo)
  const running = (p.live ?? []).filter((r) => !TERMINAL.has(r.status))
  const onDragStart = (e: DragEvent, kind: PaletteKind) => {
    e.dataTransfer.setData('application/symphony-node', kind)
    e.dataTransfer.effectAllowed = 'move'
  }
  return (
    <aside className="library">
      <section>
        <h2>Patterns</h2>
        {p.library.filter((item) => item.name !== 'maestro').map((item) => (
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

      <section className="maestro-box">
        <h2>🎼 Ask the maestro</h2>
        <PromptBox
          className="draft-input"
          title="Ask the maestro"
          placeholder="Describe what you want done, e.g. “find out why checkout got slower this week”. The maestro picks or drafts the score, debates it by complexity, then you approve and it plays."
          value={request}
          onChange={setRequest}
          ariaLabel="maestro request"
          rows={3}
        />
        <button type="button" className="primary" disabled={p.asking || !request.trim()} onClick={() => p.onAsk(request.trim())}>
          {p.asking ? 'Composing…' : '🎼 Compose & perform'}
        </button>
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

      {running.length > 0 && (
        <section data-testid="live-runs">
          <h2>Running now</h2>
          {running.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`lib-item saved${r.id === p.liveId ? ' active' : ''}`}
              onClick={() => p.onOpenLive?.(r.id)}
              title={r.goal}
              disabled={r.id === p.liveId}
            >
              <b>{r.pattern}</b> <span className={`tag status-${r.status}`}>{r.status}</span>
              {r.id === p.liveId && <span className="tag">on screen</span>}
              <small>{r.goal}</small>
            </button>
          ))}
        </section>
      )}
      <section>
        <h2>
          Saved runs
          <button type="button" className="link" onClick={p.onRefreshSaved} title="Refresh">
            ↻
          </button>
          <button
            type="button"
            className="link"
            onClick={p.onPrune}
            data-testid="prune-runs"
            title="Clean up: delete demo runs older than 7 days and compact runs older than 30 days (they still replay; the AI's raw text is dropped). Also runs by itself once a day."
          >
            🧹
          </button>
        </h2>
        {saved.length === 0 && (
          <small className="muted">{demoCount > 0 ? 'No runs with a real AI yet.' : 'Runs are saved to .symphony/runs'}</small>
        )}
        {saved.slice(0, 30).map((r) => (
          <div key={r.file} className="saved-row" data-testid="saved-run">
            <button type="button" className="lib-item saved" onClick={() => p.onOpenSaved(r.file)} title={r.goal}>
              <b>{r.pattern}</b> <span className={`tag outcome-${r.outcome}`}>{r.outcome}</span>
              {r.demo && <span className="tag demo">demo</span>}
              <small>
                {new Date(r.startedAt).toLocaleString()} · {r.steps} steps
              </small>
            </button>
            {p.onDeleteSaved &&
              (confirming === r.file ? (
                <span className="saved-confirm">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void p.onDeleteSaved!(r.file).finally(() => setConfirming(null))}
                  >
                    Delete
                  </button>
                  <button type="button" className="link" onClick={() => setConfirming(null)} aria-label="keep">
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="link saved-delete" onClick={() => setConfirming(r.file)} aria-label="delete run" title="Delete this saved run">
                  🗑
                </button>
              ))}
          </div>
        ))}
        {demoCount > 0 && (
          <button type="button" className="link show-demo" onClick={() => setShowDemo(!showDemo)} data-testid="toggle-demo-runs">
            {showDemo ? 'Hide' : 'Show'} {demoCount} offline-demo run{demoCount === 1 ? '' : 's'}
          </button>
        )}
      </section>
    </aside>
  )
}
