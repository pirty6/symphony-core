import { describe, expect, it } from 'vitest';
import { parseDuckDuckGo, webSearch } from './web-search.js';

const HTML = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2Fmocking.html&amp;rut=abc">Mocking | Guide | <b>Vitest</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Use <b>vi.useFakeTimers</b> &amp; friends&#x27; API.</a>
</div>
<div class="result results_links results_links_deep result--ad">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <a class="result__a" href="https://example.com/direct">Direct link</a>
</div>`;

describe('parseDuckDuckGo', () => {
  it('extracts real urls, titles and snippets and skips ads', () => {
    expect(parseDuckDuckGo(HTML)).toEqual([
      {
        title: 'Mocking | Guide | Vitest',
        url: 'https://vitest.dev/guide/mocking.html',
        snippet: "Use vi.useFakeTimers & friends' API.",
      },
      { title: 'Direct link', url: 'https://example.com/direct', snippet: '' },
    ]);
    expect(parseDuckDuckGo(HTML, 1)).toHaveLength(1);
    expect(parseDuckDuckGo('<html>nothing</html>')).toEqual([]);
  });

  it('queries DuckDuckGo and reports HTTP errors', async () => {
    let url = '';
    const ok = (async (u: string) => {
      url = u;
      return new Response(HTML);
    }) as unknown as typeof fetch;
    expect(await webSearch('vitest timers', { fetchImpl: ok })).toHaveLength(2);
    expect(url).toBe('https://html.duckduckgo.com/html/?q=vitest%20timers');
    const bad = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(webSearch('x', { fetchImpl: bad })).rejects.toThrow(/HTTP 503/);
  });
});
