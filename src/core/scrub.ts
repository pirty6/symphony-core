/**
 * Secrets kept out of what Symphony records: saved runs, checkpoints, memory, eval reports and
 * the live feed. Only shapes that are credentials are matched (tokens, keys, private-key
 * blocks, passwords in URLs and quoted password assignments), so code and prose stay as they
 * are. Pure and deterministic: the same text scrubs the same way, and scrubbing twice changes
 * nothing, so a run recorded scrubbed replays exactly.
 */

interface Rule {
  readonly name: string;
  readonly re: RegExp;
  /** Groups kept around the secret: the replacement is `${keep before}[REDACTED:name]${keep after}`. */
  readonly before?: number;
  readonly after?: number;
}

const RULES: readonly Rule[] = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    name: 'github-token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  { name: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: 'connection-key',
    re: /(\b(?:AccountKey|SharedAccessKey|AccessKey|Password|Pwd)=)(?!\[REDACTED:)([^;\s"'`${}]{8,})/gi,
    before: 1,
  },
  { name: 'sas-signature', re: /([?&]sig=)([A-Za-z0-9%+/=]{20,})/g, before: 1 },
  { name: 'bearer-token', re: /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g, before: 1 },
  {
    name: 'url-password',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)(?!\[REDACTED:)([^\s@/]{3,})(@)/gi,
    before: 1,
    after: 3,
  },
  {
    // A quoted literal assigned to a name that says it is secret: password = "…", "apiKey": "…".
    name: 'secret-value',
    re: /((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*)(["'])(?!\[REDACTED:)([^"'\s]{8,})(\2)/gi,
    before: 2,
    after: 4,
  },
  {
    // KEY=value lines (.env files, shell): an unquoted value of a variable named as a secret.
    name: 'secret-env',
    // At a line start, or quoted in prose (`DB_PASSWORD=…`): a finding scrubs as its file does.
    re: /(^|[\s`'"(])((?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)([^\s'"`#$[]{8,})/gm,
    before: 2,
  },
];

export const REDACTED = /\[REDACTED:[a-z-]+\]/;

/** On unless SYMPHONY_SCRUB=off (read where a process exists; always on in a browser). */
export function scrubbingOn(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.SYMPHONY_SCRUB !== 'off';
}

/** Where any rule matches in the text, as [start, end) spans. */
function matchSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const r of RULES)
    for (const m of text.matchAll(r.re)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** The text with every secret replaced by "[REDACTED:<kind>]". */
export function scrubText(text: string): string {
  // Short strings hold no credential: most values of a run, skipped cheaply.
  if (text.length < 16) return text;
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...m: unknown[]) => {
      const groups = m.slice(1, -2) as (string | undefined)[];
      const keep = (n: number | undefined) => (n === undefined ? '' : groups.slice(0, n).join(''));
      const tail = r.after === undefined ? '' : (groups[r.after - 1] ?? '');
      return `${keep(r.before)}[REDACTED:${r.name}]${tail}`;
    });
  }
  return out;
}

/** A JSON-like value with every string scrubbed; the same object when nothing changed. */
export function scrubValue<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = scrubValue(v);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = scrubValue(v);
      if (s !== v) changed = true;
      out[k] = s;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/**
 * Scrubs text that arrives in pieces (streamed model output): a secret split across two pieces
 * is still caught. Holds back the last HOLD characters (and an unfinished private-key block)
 * until more text or `end()` shows how it ends.
 */
export class StreamScrubber {
  static readonly HOLD = 512;
  private held = '';

  push(piece: string): string {
    const raw = this.held + piece;
    const begin = raw.lastIndexOf('-----BEGIN ');
    // A key block is open until its whole END line has arrived.
    const open = begin >= 0 && !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(raw.slice(begin));
    const spans = matchSpans(raw);
    const crossing = (at: number) => spans.find(([from, to]) => from < at && at < to);
    let cut = open ? begin : Math.max(0, raw.length - StreamScrubber.HOLD);
    let at = 0;
    // Never cut through something a rule matches. A secret still arriving lies within the last
    // HOLD characters, held back until it is whole.
    for (;;) {
      const inside = crossing(cut);
      if (inside) cut = inside[0];
      // At a line break, else a space, so what goes out never ends inside a word.
      const line = cut === 0 ? -1 : raw.lastIndexOf('\n', cut - 1);
      at = cut === 0 ? 0 : line >= 0 ? line + 1 : raw.lastIndexOf(' ', cut - 1) + 1;
      const still = crossing(at);
      if (!still) break;
      cut = still[0];
    }
    this.held = raw.slice(at);
    return scrubText(raw.slice(0, at));
  }

  end(): string {
    const rest = scrubText(this.held);
    this.held = '';
    return rest;
  }
}
