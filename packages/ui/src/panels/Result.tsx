import { useEffect } from 'react'
import { Markdown } from '../lib/markdown'
import { resultMarkdown, type RunResult } from '../lib/model'

function Value({ value }: { value: unknown }) {
  if (typeof value === 'string') return value.trim() ? <Markdown text={value} /> : <p className="muted">empty</p>
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
    return value.length > 0 ? <Markdown text={value.map((x) => `- ${x}`).join('\n')} /> : <p className="muted">none</p>
  }
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>
}

function Sections({ result }: { result: RunResult }) {
  return (
    <>
      {result.keys.map((k) => (
        <section key={k} className="result-section" data-testid={`result-${k}`}>
          <h4>{k}</h4>
          <Value value={result.values[k]} />
        </section>
      ))}
    </>
  )
}

/** Preview in the inspector: the delivered values, clipped, with a way to read them in full. */
export function ResultPreview({ result, onOpen }: { result: RunResult; onOpen: () => void }) {
  if (result.keys.length === 0) return null
  return (
    <div className="result-preview" data-testid="result-preview">
      <div className="result-preview-body">
        <Sections result={result} />
      </div>
      <button type="button" className="primary result-open" onClick={onOpen}>
        ⤢ Read full result
      </button>
    </div>
  )
}

/** Full-screen reader for a finished run's result. */
export function ResultReader({ result, title, subtitle, onClose }: { result: RunResult; title: string; subtitle?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const markdown = () => resultMarkdown(result, title)
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.replace(/[^\w.-]+/g, '-')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="reader-backdrop" onClick={onClose} data-testid="result-reader">
      <div className="reader" role="dialog" aria-modal="true" aria-label="run result" onClick={(e) => e.stopPropagation()}>
        <header className="reader-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="muted">{subtitle}</div>}
          </div>
          <div className="reader-actions">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(markdown())}>
              Copy
            </button>
            <button type="button" onClick={download}>
              Download .md
            </button>
            <button type="button" onClick={onClose} aria-label="close result">
              ✕
            </button>
          </div>
        </header>
        <div className="reader-body">
          <Sections result={result} />
        </div>
      </div>
    </div>
  )
}
