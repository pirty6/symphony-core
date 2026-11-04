/**
 * Paths an AI named, resolved against the files that exist: the right file written another way
 * (canonicalEntry), a folder (every file in it), a glob (every file it matches). Pure and
 * deterministic, so a replay resolves the same; what matches nothing is named, never guessed.
 */
import { canonicalEntry } from './engine.js';

export interface ResolvedPaths {
  /** Files, in the order named, each once, at most `max`. */
  readonly files: readonly string[];
  /** At the same position as `files`: the reason given for the entry that named it. */
  readonly reasons: readonly string[];
  /** Entries that name no file here: "entry — not a file of this repository". */
  readonly unmatched: readonly string[];
  /** Files named beyond `max`, in order. */
  readonly over: readonly string[];
}

const isGlob = (p: string) => /[*?[]/.test(p);

/** A glob as a regular expression over whole paths: ** any folders, * and ? within one. */
function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The files one entry names: itself, a folder's files, or a glob's matches (repo order). */
function filesOf(entry: string, all: readonly string[], set: ReadonlySet<string>): string[] {
  const exact = canonicalEntry(entry, set);
  if (exact) return [exact];
  const clean = entry
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replaceAll('\\', '/')
    .replace(/^(\.\/)+/, '');
  if (!clean) return [];
  if (isGlob(clean)) {
    const re = globRegExp(clean);
    const matched = all.filter((f) => re.test(f));
    // "app/[id]/" is a folder whose name has brackets (Next.js, SvelteKit), not a character class.
    if (matched.length > 0) return matched;
  }
  const folder = clean.replace(/\/+$/, '');
  if (folder === '' || folder === '.') return [];
  return all.filter((f) => f.startsWith(`${folder}/`));
}

export function resolvePaths(
  entries: readonly unknown[],
  reasons: readonly unknown[],
  all: readonly string[],
  max: number,
): ResolvedPaths {
  const set = new Set(all);
  const seen = new Set<string>();
  const named: { file: string; reason: string }[] = [];
  const unmatched: string[] = [];
  entries.forEach((e, i) => {
    if (typeof e !== 'string' || !e.trim()) return;
    const files = filesOf(e, all, set);
    if (files.length === 0) {
      unmatched.push(`${e.trim()} — not a file of this repository`);
      return;
    }
    const why = typeof reasons[i] === 'string' ? (reasons[i] as string) : '';
    const one = files.length === 1 && files[0] === canonicalEntry(e, set);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      named.push({ file, reason: one ? why : `${why}${why ? ' ' : ''}(in ${e.trim()})` });
    }
  });
  const cap = Number.isFinite(max) && max >= 0 ? Math.floor(max) : named.length;
  return {
    files: named.slice(0, cap).map((n) => n.file),
    reasons: named.slice(0, cap).map((n) => n.reason),
    unmatched,
    over: named.slice(cap).map((n) => n.file),
  };
}
