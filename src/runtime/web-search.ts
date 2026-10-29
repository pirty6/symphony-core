/** Keyless web search (DuckDuckGo HTML endpoint) for agents with the 'web' capability. */

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  '#x27': "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (m, name: string) => {
    if (name in ENTITIES) return ENTITIES[name]!;
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return m;
  });
}

const text = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

function realUrl(href: string): string {
  const decoded = decodeEntities(href);
  const m = /[?&]uddg=([^&]+)/.exec(decoded);
  if (m) return decodeURIComponent(m[1]!);
  return decoded.startsWith('//') ? `https:${decoded}` : decoded;
}

export function parseDuckDuckGo(html: string, limit = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const block of blocks) {
    const link =
      /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block) ??
      /href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = realUrl(link[1]!);
    if (url.includes('duckduckgo.com/y.js')) continue; // ads
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({ title: text(link[2]!), url, snippet: snippet ? text(snippet[1]!) : '' });
    if (results.length >= limit) break;
  }
  return results;
}

export async function webSearch(
  query: string,
  opts: { limit?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SearchResult[]> {
  const res = await (opts.fetchImpl ?? fetch)(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (symphony-core research agent)' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
  if (!res.ok) throw new Error(`web search failed: HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text(), opts.limit);
}
