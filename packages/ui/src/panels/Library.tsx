import { useState, type DragEvent, type ReactNode } from 'react'
import { TERMINAL, type LibraryItem, type LiveRun, type SavedSummary } from '../lib/api'
import { runHover } from '../lib/saved'
import type { FeatureRow, PaletteKind } from '../lib/model'
import { Collapsible } from './Collapsible'
import { PromptBox } from './PromptBox'
import { RunTimer } from './RunTimer'

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
  /** Optional patterns (src/patterns/extras) are listed. */
  extras?: boolean
  onExtras?: (on: boolean) => void
  /** Delete one saved run; resolves once it is gone. */
  onDeleteSaved?: (file: string) => Promise<void>
  onAsk: (request: string) => void
  /** The switches the open pattern has (or, for the maestro, every pattern it may compose). */
  features?: readonly FeatureRow[]
  onFeature?: (row: FeatureRow, value: string) => void
  /** Every switch of the open pattern back to its default. */
  onResetFeatures?: () => void
  /** On the opening screen, which has its own maestro prompt: this one is not shown. */
  home?: boolean
  onHome?: () => void
  /** The button that folds this sidebar (shown first, and alone while folded). */
  toggle?: ReactNode
}


/** How many switches are away from their defaults. */
const changedFeatures = (rows: readonly FeatureRow[]) => rows.filter((r) => r.value !== r.default).length

export function Library(p: Props) {
  const [request, setRequest] = useState('')
  const [showDemo, setShowDemo] = useState(false)
  /** The saved run whose delete is waiting for a second click. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const demoCount = p.saved.filter((r) => r.demo).length
  const saved = showDemo ? p.saved : p.saved.filter((r) => !r.demo)
  const running = (p.live ?? []).filter((r) => !TERMINAL.has(r.status))
  // An approval, a stuck step or a step-mode pause: the run waits for a person.
  const waiting = running.filter((r) => r.status === 'awaiting-approval' || r.status === 'paused').length
  const onDragStart = (e: DragEvent, kind: PaletteKind) => {
    e.dataTransfer.setData('application/symphony-node', kind)
    e.dataTransfer.effectAllowed = 'move'
  }
  return (
    <aside className="library">
      {p.toggle}
      {p.onHome && (
        <button
          type="button"
          className={`home-link${p.home ? ' active' : ''}`}
          onClick={p.onHome}
          disabled={p.home}
          title="Back to the opening screen (a run keeps playing; it stays under Running now)"
          data-testid="home-link"
        >
          ⌂ Home
        </button>
      )}
      {!p.home && (
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
      )}

      <Collapsible
        id="patterns"
        title="Patterns"
        extra={
          p.onExtras && (
            <label className="extras-toggle" title="Show optional patterns (src/patterns/extras), e.g. metaphor">
              <input type="checkbox" checked={p.extras ?? false} onChange={(e) => p.onExtras!(e.target.checked)} aria-label="extra patterns" />
              extras
            </label>
          )
        }
      >
        {p.library.filter((item) => item.name !== 'maestro').map((item) => (
          <button
            type="button"
            key={item.name}
            className={`lib-item${item.name === p.activeName ? ' active' : ''}`}
            onClick={() => p.onLoad(item)}
            title={item.description}
          >
            <b>{item.name}</b>
            {item.source !== 'builtin' && <span className="tag">{item.source}</span>}
            <small>{item.description}</small>
          </button>
        ))}
        <button type="button" className="lib-new" onClick={p.onNew}>
          + Blank pattern
        </button>
      </Collapsible>

      {!p.home && p.features && p.onFeature && (
        <Collapsible
          id="features"
          title="Features"
          extra={
            changedFeatures(p.features) > 0 && (
              <span className="section-actions">
                {/* They are kept between visits: say so, so a trial setting is not forgotten. */}
                <span className="tag" data-testid="features-changed" title="Switches away from their defaults, kept between visits">
                  {changedFeatures(p.features)} changed
                </span>
                {p.onResetFeatures && (
                  <button type="button" className="link" onClick={p.onResetFeatures} title="Every switch back to its default">
                    Reset
                  </button>
                )}
              </span>
            )
          }
        >
          {p.features.length === 0 ? (
            <p className="muted small">This pattern has no switches.</p>
          ) : (
            p.features.map((row) => <FeatureSwitch key={row.feature.field} row={row} onChange={p.onFeature!} />)
          )}
        </Collapsible>
      )}

      {!p.home && p.editable && (
        <Collapsible id="palette" title="Add node (drag)">
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
        </Collapsible>
      )}

      {running.length > 0 && (
        <div data-testid="live-runs">
          <Collapsible
            id="running"
            // Closed by default; the title still says how many, and how many wait for you.
            defaultOpen={false}
            title={
              <>
                <span className="nowrap">Running now · {running.length}</span>
                {waiting > 0 && (
                  <span className="waiting" data-testid="live-waiting" title={`${waiting} waiting for you: an approval, a stuck step or a pause`}>
                    ✋ {waiting}
                  </span>
                )}
              </>
            }
          >
            {running.map((r) => (
              <button
                type="button"
                key={r.id}
                className={`lib-item saved${r.id === p.liveId ? ' active' : ''}`}
                onClick={() => p.onOpenLive?.(r.id)}
                title={runHover(r)}
                disabled={r.id === p.liveId}
              >
                <b>{r.pattern}</b> <span className={`tag status-${r.status}`}>{r.status}</span>
                {r.source === 'chat' && (
                  <span className="tag" data-testid="from-chat">
                    chat
                  </span>
                )}
                {r.source === 'cli' && (
                  <span className="tag" data-testid="from-cli">
                    cli
                  </span>
                )}
                {r.id === p.liveId && <span className="tag">on screen</span>}
                <RunTimer run={r} history={p.saved} />
                <small>{r.title ?? r.goal}</small>
              </button>
            ))}
          </Collapsible>
        </div>
      )}
      <Collapsible
        id="saved"
        title="Saved runs"
        extra={
          <span className="section-actions">
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
          </span>
        }
      >
        {saved.length === 0 && (
          <small className="muted">{demoCount > 0 ? 'No runs with a real AI yet.' : 'Runs are saved on this machine, outside your repository (~/.symphony)'}</small>
        )}
        {saved.slice(0, 30).map((r) => (
          <div key={r.file} className="saved-row" data-testid="saved-run" data-file={r.file}>
            <button type="button" className="lib-item saved" onClick={() => p.onOpenSaved(r.file)} title={r.goal}>
              <b>{r.pattern}</b> <span className={`tag outcome-${r.outcome}`}>{r.outcome}</span>
              {r.demo && <span className="tag demo">demo</span>}
              <small>
                {new Date(r.startedAt).toLocaleString()} · {r.steps} steps
                {r.usage ? ` · ${Math.round(r.usage.inputTokens / 1000)}k tokens in${r.usage.premiumRequests ? ` · ${+r.usage.premiumRequests.toFixed(1)} premium` : ''}` : ''}
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
      </Collapsible>
    </aside>
  )
}

/** One switch: a checkbox for on/off, a select for named choices. Kept for every run until changed. */
function FeatureSwitch({ row, onChange }: { row: FeatureRow; onChange: (row: FeatureRow, value: string) => void }) {
  const { feature: f, value } = row
  const changed = value !== row.default
  const title = `${f.description}\n\nPatterns: ${row.patterns.join(', ')}. Default: ${row.default}. Applies to the runs you start (and those the maestro composes), unless a run input says otherwise.`
  return (
    <div className={`feature${changed ? ' changed' : ''}`} title={title} data-testid={`feature-${f.field}`}>
      {f.choices ? (
        // The choice on its own row, the card's full width: it never crowds the title.
        <label className="feature-choice">
          <span className="feature-title">
            {f.label}
            {changed && <span className="tag">changed</span>}
          </span>
          <select value={value} onChange={(e) => onChange(row, e.target.value)} aria-label={f.label}>
            {f.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          <input
            type="checkbox"
            checked={value === 'true'}
            onChange={(e) => onChange(row, e.target.checked ? 'true' : 'false')}
            aria-label={f.label}
          />
          <span className="feature-title">
            {f.label}
            {changed && <span className="tag">changed</span>}
          </span>
        </label>
      )}
      <small>{f.description}</small>
    </div>
  )
}
