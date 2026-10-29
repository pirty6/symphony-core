import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
  /** What the field is, shown on the large editor. */
  title: string
  placeholder?: string
  ariaLabel: string
  className?: string
  rows?: number
}

/**
 * A text box for prompts: it grows with its text, and ⤢ opens a large editor
 * (Esc or Done closes it). Empty boxes show their example as a hint, never as text.
 */
export function PromptBox(p: Props) {
  const [big, setBig] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Grow with the text (up to the CSS max-height), shrink back when it is deleted.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [p.value])
  return (
    <div className={`prompt-box ${p.className ?? ''}`}>
      <textarea
        ref={ref}
        rows={p.rows ?? 2}
        value={p.value}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
        aria-label={p.ariaLabel}
      />
      <button type="button" className="link prompt-expand" onClick={() => setBig(true)} title="Write in a large editor" aria-label="large editor">
        ⤢
      </button>
      {big && (
        <div
          className="reader-backdrop"
          onClick={(e) => e.target === e.currentTarget && setBig(false)}
          onKeyDown={(e) => e.key === 'Escape' && setBig(false)}
          role="dialog"
          aria-label={`${p.title} editor`}
        >
          <div className="reader prompt-editor">
            <div className="reader-head">
              <h2>{p.title}</h2>
              <div className="reader-actions">
                <button type="button" className="primary" onClick={() => setBig(false)}>
                  Done
                </button>
              </div>
            </div>
            <textarea
              autoFocus
              className="prompt-editor-text"
              value={p.value}
              placeholder={p.placeholder}
              onChange={(e) => p.onChange(e.target.value)}
              aria-label="large editor text"
            />
          </div>
        </div>
      )}
    </div>
  )
}
