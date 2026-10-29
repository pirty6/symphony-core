/**
 * A small Markdown renderer for AI answers: headings, paragraphs, lists,
 * fenced code, inline code, bold, italics and links. It builds React
 * elements (never raw HTML), so model output cannot inject markup.
 */
import { Fragment, type ReactNode } from 'react'
import { blocks } from './markdown-blocks'

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*\n]*\*)/g

function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined
}

function link(href: string, text: ReactNode, key: number): ReactNode {
  const safe = safeHref(href)
  return safe ? (
    <a key={key} href={safe} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  ) : (
    <Fragment key={key}>{text}</Fragment>
  )
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const [whole, code, bold, mdLink, mdHref, bare, em] = m
    if (code) out.push(<code key={k++}>{code.slice(1, -1)}</code>)
    else if (bold) out.push(<strong key={k++}>{inline(bold.slice(2, -2))}</strong>)
    else if (mdLink && mdHref) out.push(link(mdHref, mdLink.slice(1, mdLink.indexOf('](')), k++))
    else if (bare) out.push(link(bare, bare, k++))
    else if (em) out.push(<em key={k++}>{em.slice(1, -1)}</em>)
    else out.push(whole)
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={['md', className].filter(Boolean).join(' ')}>
      {blocks(text).map((b, i) => {
        switch (b.kind) {
          case 'h': {
            const Tag = `h${Math.min(b.level + 2, 6)}` as 'h3'
            return <Tag key={i}>{inline(b.text)}</Tag>
          }
          case 'code':
            return (
              <pre key={i} className="md-code">
                {b.text}
              </pre>
            )
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </Tag>
            )
          }
          default:
            return <p key={i}>{inline(b.text)}</p>
        }
      })}
    </div>
  )
}
