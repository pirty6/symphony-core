import { useState } from 'react'

const KEY = 'symphony.sidebar.'

/** Whether a sidebar was left open (open until you fold it), remembered across reloads. */
export function useSidebar(side: 'left' | 'right'): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY + side) !== '0'
    } catch {
      return true
    }
  })
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(KEY + side, open ? '0' : '1')
    } catch {
      // Private mode: it still folds, it just is not remembered.
    }
  }
  return [open, toggle]
}
