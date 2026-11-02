import { useState, type ReactNode } from 'react'

const KEY = 'symphony.open.'

/** Whether a section was left open (default when never toggled). */
function wasOpen(id: string, byDefault: boolean): boolean {
  try {
    const v = localStorage.getItem(KEY + id)
    return v === null ? byDefault : v === '1'
  } catch {
    return byDefault
  }
}

interface Props {
  /** Remembers open or closed under this id, across reloads. */
  id: string
  title: ReactNode
  /** Controls beside the title (they do not open or close it). */
  extra?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}

/** A sidebar section whose title opens and closes it. */
export function Collapsible(p: Props) {
  const [open, setOpen] = useState(() => wasOpen(p.id, p.defaultOpen ?? true))
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(KEY + p.id, open ? '0' : '1')
    } catch {
      // Private mode: it still toggles, it just is not remembered.
    }
  }
  return (
    <section className={`collapsible${open ? ' open' : ''}`} data-testid={`section-${p.id}`}>
      <h2>
        <button type="button" className="collapse-toggle" aria-expanded={open} onClick={toggle}>
          <span className="chevron" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          {p.title}
        </button>
        {p.extra}
      </h2>
      {open && p.children}
    </section>
  )
}
