import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { blocks, Markdown } from './markdown'

describe('markdown', () => {
  it('splits headings, paragraphs, lists and code', () => {
    const md = '# Title\nline one\nline two\n\n1. first\n   continued\n2. second\n- a\n\n```\ncode **not bold**\n```'
    expect(blocks(md)).toEqual([
      { kind: 'h', level: 1, text: 'Title' },
      { kind: 'p', text: 'line one line two' },
      { kind: 'list', ordered: true, items: ['first continued', 'second'] },
      { kind: 'list', ordered: false, items: ['a'] },
      { kind: 'code', text: 'code **not bold**' },
    ])
  })

  it('renders inline code, bold, italics and safe links', () => {
    const { container } = render(
      <Markdown text={'See `src/a.ts:1`, **bold**, *it*, [docs](https://oxc.rs/x) and https://example.com/a.'} />,
    )
    expect(container.querySelector('code')).toHaveTextContent('src/a.ts:1')
    expect(container.querySelector('strong')).toHaveTextContent('bold')
    expect(container.querySelector('em')).toHaveTextContent('it')
    const links = Array.from(container.querySelectorAll('a'))
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://oxc.rs/x', 'https://example.com/a'])
    expect(links.every((a) => a.getAttribute('rel') === 'noopener noreferrer')).toBe(true)
  })

  it('never turns model output into markup or script links', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> [x](javascript:alert(1))'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>')
  })
})
