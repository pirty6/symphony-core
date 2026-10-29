/** Block structure of Markdown answers: headings, paragraphs, lists and fenced code. Pure. */

export type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

const BULLET = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/

export function blocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!)
      out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      out.push({ kind: 'h', level: h[1]!.length, text: h[2]! })
      continue
    }
    const b = BULLET.exec(line)
    if (b) {
      flush()
      const ordered = b[1] !== undefined
      const prev = out.at(-1)
      if (prev?.kind === 'list' && prev.ordered === ordered) prev.items.push(b[2]!)
      else out.push({ kind: 'list', ordered, items: [b[2]!] })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const prev = out.at(-1)
    // An indented line right after a list item continues that item.
    if (!para.length && prev?.kind === 'list' && /^\s{2,}\S/.test(line)) {
      prev.items[prev.items.length - 1] += ` ${line.trim()}`
      continue
    }
    para.push(line.trim())
  }
  flush()
  return out
}
