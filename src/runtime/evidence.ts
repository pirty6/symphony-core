/**
 * Deterministic checks on cited evidence. A finding that cites a workspace file
 * ("src/a.ts:12 — fact", optionally with a `verbatim quote`) is verified against the
 * file: it must exist, the line must exist, and the quote must appear near that line.
 * Findings that cite something else (a URL, a commit, an issue) are passed through:
 * they cannot be checked here.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface CitationCheck {
  /** Findings that passed, or that cite something other than a workspace file. */
  readonly valid: readonly string[];
  /** Findings whose file citation is wrong, with why. */
  readonly invalid: readonly { readonly finding: string; readonly reason: string }[];
  /** How many findings cited a workspace file (and so were checked). */
  readonly checked: number;
}

/** "F12 src/a.ts:3-5 — fact `quote`": optional id, path with an extension, line or range. */
const FILE_CITATION = /^(?:F\d+\s+)?\[?([\w@./-]+\.[A-Za-z0-9]+)\]?:(\d+)(?:-(\d+))?\b/;
const QUOTE = /`([^`]{4,})`/;
/** How far from the cited line a quote may be (models are often off by a few lines). */
const SLACK = 3;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export async function checkCitations(
  workspace: string,
  findings: readonly string[],
): Promise<CitationCheck> {
  const valid: string[] = [];
  const invalid: { finding: string; reason: string }[] = [];
  const files = new Map<string, string[] | undefined>();
  let checked = 0;
  for (const finding of findings) {
    const m = FILE_CITATION.exec(finding.trim());
    if (!m || m[1]!.includes('://')) {
      valid.push(finding);
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
    const quote = QUOTE.exec(finding.slice(m[0].length))?.[1];
    if (quote) {
      const near = squash(
        lines.slice(Math.max(0, from - 1 - SLACK), Math.min(lines.length, to + SLACK)).join(' '),
      );
      if (!near.includes(squash(quote))) {
        invalid.push({
          finding,
          reason: `the quote \`${quote.slice(0, 60)}\` is not at ${path}:${from}`,
        });
        continue;
      }
    }
    valid.push(finding);
  }
  return { valid, invalid, checked };
}
