/**
 * Deterministic checks on cited evidence. A finding that cites a workspace file
 * ("src/a.ts:12 — fact", optionally with a `verbatim quote`) is verified against the
 * file: it must exist, the line must exist, and the quote must appear near that line.
 * The citation may sit anywhere in the text, in backticks or bold, or as "a.ts line 3".
 * Findings that cite something else (a URL, "source | location — fact", a commit, an
 * issue) are passed through: they cannot be checked here. A finding that cites
 * nothing at all is rejected.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface CitationCheck {
  /** Findings that passed, or that cite a source other than a workspace file. */
  readonly valid: readonly string[];
  /** Findings whose file citation is wrong, with why. */
  readonly invalid: readonly { readonly finding: string; readonly reason: string }[];
  /** How many findings cited a workspace file (and so were checked). */
  readonly checked: number;
}

/** "src/a.ts:3-5": a path with an extension, then a line or a range (anywhere in the text). */
const FILE_CITATION =
  /(?<![\w@./-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?!\d)/;
/** Other ways of writing a line: "a.ts line 3", "a.ts, line 3", "a.ts | line 3", "a.ts (line 3)", "a.ts#L3", "a.ts L3". */
const LINE_WORD = /([\w@./-]+\.[A-Za-z0-9]+)(?:\s*[,|(]\s*|\s+|#)(?:line\s*|L)(\d+)\)?/gi;
/** Something checked elsewhere: a URL, "source | location — fact", a commit, an issue or PR. */
const OTHER_SOURCE = /https?:\/\/|^\s*(?:F\d+\s+)?[\w:.-]+\s+\|\s+\S|\b[0-9a-f]{7,40}\b|#\d+/i;
/** A quote needs at least this many characters to prove anything. */
const MIN_QUOTE = 8;
/** A cited range wider than this proves nothing about where the fact is. */
const MAX_SPAN = 25;
/** How far from the cited line a quote may be (models are often off by a few lines). */
const SLACK = 3;
const PATH_LIKE = /^[\w@./-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Compare without markdown that models drop or double: backticks and ** / __ emphasis. */
const plain = (s: string) => squash(s.replace(/`/g, '').replace(/\*\*|__/g, ''));

/** Where a finding cites a workspace file, wherever it says so and however it is dressed. */
function fileCitation(finding: string): RegExpExecArray | null {
  const text = finding
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\*\*|__/g, '')
    // A backticked path ("`src/a.ts`:3" or "`src/a.ts:3`") is still a path.
    .replace(/`([\w@./-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?)`/g, '$1')
    .replace(LINE_WORD, '$1:$2');
  return FILE_CITATION.exec(text);
}

/**
 * The quotes a finding offers: every backtick span, and everything between the
 * first and last backtick (a quoted line that itself contains backticks). A path
 * in backticks is the citation, not a quote.
 */
function quotesOf(text: string): string[] {
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const first = text.indexOf('`');
  const last = text.lastIndexOf('`');
  if (first >= 0 && last > first) spans.push(text.slice(first + 1, last));
  return [...new Set(spans.map(plain))].filter((q) => q.length >= MIN_QUOTE && !PATH_LIKE.test(q));
}

export async function checkCitations(
  workspace: string,
  findings: readonly string[],
): Promise<CitationCheck> {
  const valid: string[] = [];
  const invalid: { finding: string; reason: string }[] = [];
  const files = new Map<string, string[] | undefined>();
  let checked = 0;
  for (const finding of findings) {
    const m = fileCitation(finding);
    if (!m) {
      // Not a workspace file: it must still point at something a reader can check.
      if (OTHER_SOURCE.test(finding)) valid.push(finding);
      else
        invalid.push({
          finding,
          reason:
            'cites nothing: give path:line with a `quote`, a URL, "source | location — fact", a commit or an issue/PR number',
        });
      continue;
    }
    checked += 1;
    const path = m[1]!;
    const full = resolve(workspace, path);
    const inside = !isAbsolute(path) && !relative(workspace, full).startsWith('..');
    if (!files.has(path)) {
      files.set(
        path,
        inside
          ? await readFile(full, 'utf8').then(
              (t) => t.split('\n'),
              () => undefined,
            )
          : undefined,
      );
    }
    const lines = files.get(path);
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    if (!lines) {
      invalid.push({ finding, reason: `${path} does not exist in the workspace` });
      continue;
    }
    if (from < 1 || to < from || from > lines.length) {
      invalid.push({ finding, reason: `${path} has ${lines.length} lines, not line ${from}` });
      continue;
    }
    if (to - from > MAX_SPAN) {
      invalid.push({
        finding,
        reason: `${path}:${from}-${to} spans ${to - from + 1} lines: cite the line, or at most ${MAX_SPAN + 1}`,
      });
      continue;
    }
    // A quote is required: without one only the line's existence could be checked.
    const quotes = quotesOf(finding);
    if (quotes.length === 0) {
      invalid.push({
        finding,
        reason: `no quote: add a short verbatim quote from ${path}:${from} in backticks`,
      });
      continue;
    }
    const near = plain(
      lines.slice(Math.max(0, from - 1 - SLACK), Math.min(lines.length, to + SLACK)).join(' '),
    );
    if (!quotes.some((q) => near.includes(q))) {
      invalid.push({
        finding,
        reason: `the quote \`${quotes[0]!.slice(0, 60)}\` is not at ${path}:${from}`,
      });
      continue;
    }
    valid.push(finding);
  }
  return { valid, invalid, checked };
}
