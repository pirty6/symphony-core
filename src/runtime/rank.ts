/**
 * Deterministic ordering of a file list by how much it shares with the question: an order
 * for reading, never a filter (every path given comes back). Terms come from what the
 * person asked and the plan, not from the AI's hypotheses, so the order cannot be steered
 * by a guess.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Words too common to say where evidence is. */
const STOP = new Set(
  'what which where when does with that this from have into than them they about there their would could should these those been being were will each only also more most some such very just then else over under after before because while make made using used file files code work works into your other same like need needs between'.split(
    ' ',
  ),
);
/** Most terms searched: more adds time, not order. */
const MAX_TERMS = 24;

/** Search terms from text: words of 4+ characters, lower case, without common words. */
export function termsOf(texts: readonly string[]): string[] {
  const words = texts
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/**
 * `paths` ordered by score (distinct terms in the file's text, plus twice the terms in its
 * path), ties in the given order; `matched` are those with any hit. Not a git repository:
 * path terms only.
 */
/** git greps run at once while ranking. */
const GREPS_AT_ONCE = 4;

export async function rankFiles(
  workspace: string,
  paths: readonly string[],
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<{ ranked: string[]; matched: string[] }> {
  const terms = termsOf(texts);
  const score = new Map(paths.map((p) => [p, 0]));
  const grep = (term: string) =>
    run('git', ['grep', '-l', '-i', '-I', '-F', '-e', term], {
      cwd: workspace,
      maxBuffer: 64 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    }).catch(() => ({ stdout: '' }));
  // A few greps at once (each is threaded already); scores are sums, so the order is the same.
  for (let i = 0; i < terms.length; i += GREPS_AT_ONCE) {
    const batch = terms.slice(i, i + GREPS_AT_ONCE);
    const outs = await Promise.all(batch.map(grep));
    batch.forEach((term, j) => {
      for (const hit of outs[j]!.stdout.split('\n'))
        if (score.has(hit)) score.set(hit, score.get(hit)! + 1);
      for (const p of paths) if (p.toLowerCase().includes(term)) score.set(p, score.get(p)! + 2);
    });
  }
  const ranked = paths
    .map((p, i) => ({ p, i, s: score.get(p) ?? 0 }))
    .toSorted((a, b) => b.s - a.s || a.i - b.i);
  return { ranked: ranked.map((x) => x.p), matched: ranked.filter((x) => x.s > 0).map((x) => x.p) };
}
