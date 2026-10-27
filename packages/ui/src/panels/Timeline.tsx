import { useEffect, useRef } from 'react'
import type { Frame } from '@core/replay'
import { describeEvent } from '../lib/events'
import type { EngineEvent } from '@core/types'

interface Props {
  frames: readonly Frame[]
  cursor: number | null
  onSeek: (index: number | null) => void
}

const ICON: Record<EngineEvent['type'], string> = {
  'run-started': '▶',
  'node-entered': '→',
  'guard-evaluated': '◆',
  'edge-taken': '⇢',
  paused: '⏸',
  'response-rejected': '✗',
  'node-completed': 'Δ',
  'run-completed': '✔',
  'run-failed': '✘',
}

export function Timeline({ frames, cursor, onSeek }: Props) {
  const index = cursor ?? frames.length - 1
  const current = useRef<HTMLLIElement>(null)
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: 'nearest' })
  }, [index])
  return (
    <footer className="timeline">
      <div className="tl-controls">
        <button type="button" onClick={() => onSeek(Math.max(0, index - 1))} disabled={index <= 0} aria-label="previous event">
          ◀
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={Math.max(0, index)}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="timeline"
          disabled={frames.length === 0}
        />
        <button type="button" onClick={() => onSeek(Math.min(frames.length - 1, index + 1))} disabled={index >= frames.length - 1} aria-label="next event">
          ▶
        </button>
        <button type="button" className={cursor === null ? 'on' : ''} onClick={() => onSeek(null)} title="Follow the latest event">
          ● live
        </button>
        <span className="muted">
          {frames.length ? `${index + 1} / ${frames.length}` : 'no events yet'}
        </span>
      </div>
      <ol className="tl-events" data-testid="timeline-events">
        {frames.map((f, i) =>
          f.event ? (
            <li key={i} ref={i === index ? current : undefined} className={`tl-${f.event.type}${i === index ? ' current' : ''}`}>
              <button type="button" onClick={() => onSeek(i)}>
                <span className="tl-icon">{ICON[f.event.type]}</span> {describeEvent(f.event)}
              </button>
            </li>
          ) : null,
        )}
      </ol>
    </footer>
  )
}
