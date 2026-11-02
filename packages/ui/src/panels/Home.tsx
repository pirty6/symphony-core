import { useState, type ReactNode } from 'react'
import { DEMO_ONLY } from '@core/catalog'
import type { LibraryItem } from '../lib/api'
import { PromptBox } from './PromptBox'

interface Props {
  library: readonly LibraryItem[]
  asking: boolean
  onAsk: (request: string) => void
  onOpen: (item: LibraryItem) => void
  /** Errors and notices: there is no inspector on this screen to show them. */
  children?: ReactNode
}

/** The opening screen: ask the maestro, or open a pattern. */
export function Home(p: Props) {
  const [request, setRequest] = useState('')
  // Real work only: the maestro is the prompt above, and demo games are not offered.
  const patterns = p.library.filter((i) => i.name !== 'maestro' && i.source === 'builtin' && !DEMO_ONLY.has(i.name))
  const ask = () => {
    if (request.trim() && !p.asking) p.onAsk(request.trim())
  }
  return (
    <main className="home" data-testid="home">
      <div className="home-box">
        <h1>What should the orchestra play?</h1>
        <p className="muted">
          Describe the work. The maestro finds the pattern that fits, tailors it, debates it by complexity, and plays it once you approve.
        </p>
        <div
          className="home-prompt"
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter composes; Enter alone starts a new line.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              ask()
            }
          }}
        >
          <PromptBox
            className="draft-input"
            title="Ask the maestro"
            placeholder="e.g. “find out why checkout got slower this week”, “fix the flaky login test”, “review my branch”"
            value={request}
            onChange={setRequest}
            ariaLabel="maestro request"
            rows={4}
          />
          <div className="home-actions">
            <small className="muted">⌘/Ctrl + Enter</small>
            <button type="button" className="primary" disabled={p.asking || !request.trim()} onClick={ask}>
              {p.asking ? 'Composing…' : '🎼 Compose & perform'}
            </button>
          </div>
        </div>
        {p.children}
        {patterns.length > 0 && (
          <div className="home-patterns">
            <span className="muted">or open a pattern:</span>
            {patterns.map((item) => (
              <button type="button" key={item.name} className="home-chip" onClick={() => p.onOpen(item)} title={item.description}>
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
