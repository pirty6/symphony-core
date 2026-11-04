interface Props {
  side: 'left' | 'right'
  open: boolean
  /** What the sidebar holds, for the button's name ("library", "inspector"). */
  name: string
  onToggle: () => void
}

/** The button that folds a sidebar to a thin rail, and opens it again. */
export function SideToggle(p: Props) {
  // An arrow pointing where the sidebar goes when clicked.
  const arrow = (p.side === 'left') === p.open ? '«' : '»'
  return (
    <button
      type="button"
      className={`side-toggle side-${p.side}`}
      aria-expanded={p.open}
      aria-label={`${p.open ? 'Hide' : 'Show'} the ${p.name}`}
      title={`${p.open ? 'Hide' : 'Show'} the ${p.name}`}
      data-testid={`toggle-${p.side}`}
      onClick={p.onToggle}
    >
      {arrow}
    </button>
  )
}
