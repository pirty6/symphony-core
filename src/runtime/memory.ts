/**
 * The maestro's memory of approved compositions, kept in memory.json in the workspace's
 * Symphony folder (outside the workspace): the pattern, complexity and tailoring it composed
 * for a request and you approved. The same request again reuses it without a debate; similar
 * ones are offered as precedent. Recall ranks by the words a request shares with earlier ones,
 * rarer words weighing more.
 *
 * Facts and lessons from earlier runs were kept here too, until a measured run showed they
 * did not help (docs/trials.md, "Feature measurements"): files written then still hold them,
 * and the next save drops them.
 */
import { scrubbingOn, scrubValue } from '../core/scrub.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from './state.js';

/** An approved maestro composition. */
export interface Composition {
  readonly request: string;
  readonly chosen: string;
  readonly complexity: number;
  readonly thenPattern: string;
  /** How a library pattern was tailored ({} for new or reshaped ones). */
  readonly adaptation: Readonly<Record<string, unknown>>;
  /** The approved pattern, for new or reshaped ones ({} for adapted library patterns). */
  readonly pattern: Readonly<Record<string, unknown>>;
  /** Fingerprint of the library pattern it adapted: a changed pattern is not reused as is. */
  readonly template: string;
  readonly at: string;
}

interface MemoryFile {
  readonly compositions?: readonly Composition[];
}

/** What recall ranks: entries by their text. */
interface Ranked {
  readonly text: string;
}

const MAX_COMPOSITIONS = 200;
/** Least relevance a recalled entry needs (a rare shared word scores about 2-7). */
export const MIN_SCORE = 1;

/** Outside the workspace (src/runtime/state.ts): what runs learn stays on this machine. */
export const memoryPath = (workspace: string) => join(stateDir(workspace), 'memory.json');

/**
 * The store, or an empty one when there is none yet. A store that cannot be read
 * (corrupt, unreadable) is empty for reading, but never overwritten: writing it
 * would lose everything it holds.
 */
async function load(workspace: string, forWrite = false): Promise<MemoryFile> {
  let raw: string;
  try {
    raw = await readFile(memoryPath(workspace), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || !forWrite) return {};
    throw e;
  }
  try {
    const m = JSON.parse(raw) as Partial<MemoryFile>;
    return { compositions: m.compositions ?? [] };
  } catch (e) {
    if (forWrite)
      throw new Error(
        `${memoryPath(workspace)} is not valid JSON; not overwriting it: ${(e as Error).message}`,
        { cause: e },
      );
    return {};
  }
}

async function save(workspace: string, m: MemoryFile): Promise<void> {
  const file = memoryPath(workspace);
  await mkdir(dirname(file), { recursive: true });
  // Write then rename, so parallel runs never leave a half-written file.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  // A last scrub where it is written.
  await writeFile(tmp, `${JSON.stringify(scrubbingOn() ? scrubValue(m) : m, null, 1)}\n`);
  await rename(tmp, file);
}

/** One update at a time per workspace in this process, so parallel runs add, not overwrite. */
const queues = new Map<string, Promise<unknown>>();
function update(workspace: string, change: (m: MemoryFile) => MemoryFile): Promise<void> {
  const prev = queues.get(workspace) ?? Promise.resolve();
  const next = prev.then(async () => save(workspace, change(await load(workspace, true))));
  queues.set(
    workspace,
    next.catch(() => undefined),
  );
  return next;
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4),
  );

/**
 * Entries sharing words with the query, best first. A word counts by its rarity
 * among the entries (inverse document frequency): "error" matches everything,
 * "paginate" says something.
 */
function ranked<E extends Ranked>(entries: readonly E[], query: string, limit: number): E[] {
  const q = words(query);
  const bags = entries.map((e) => words(e.text));
  const df = new Map<string, number>();
  for (const bag of bags) for (const w of bag) if (q.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const weight = (w: string) => Math.log(1 + entries.length / (df.get(w) ?? 1));
  return (
    entries
      .map((e, i) => ({
        e,
        i,
        score: [...bags[i]!].filter((w) => q.has(w)).reduce((sum, w) => sum + weight(w), 0),
      }))
      // One very common word shared is noise, not a lead (a small store cannot tell rare words).
      .filter(
        (x) => x.score > 0 && x.score >= Math.min(MIN_SCORE, 0.5 * Math.log(1 + entries.length)),
      )
      .toSorted((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.e)
  );
}

// ── compositions ───────────────────────────────────────────────────

/** Requests that differ only in case and spacing are the same request. */
export const sameRequest = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Remember an approved composition; the newest one per request and pattern wins. */
export async function rememberComposition(
  workspace: string,
  c: Omit<Composition, 'at'>,
  at = new Date().toISOString(),
): Promise<void> {
  if (!c.request.trim() || !c.chosen) return;
  const key = `${sameRequest(c.request)}\u0000${c.chosen}`;
  await update(workspace, (m) => ({
    ...m,
    compositions: [
      { ...c, at },
      ...(m.compositions ?? []).filter((x) => `${sameRequest(x.request)}\u0000${x.chosen}` !== key),
    ].slice(0, MAX_COMPOSITIONS),
  }));
}

const briefly = (x: unknown, max: number): string => {
  const s = JSON.stringify(x);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * Approved compositions for a request: `exact` is the newest one for the same
 * request whose pattern is still in the library unchanged (fingerprint), to reuse
 * as is; `similar` are the closest others (shared words), as precedent.
 */
export async function recallCompositions(
  workspace: string,
  request: string,
  fingerprint: (pattern: string) => string | undefined,
  limit = 3,
): Promise<{ exact: Composition | undefined; similar: string[] }> {
  const all = (await load(workspace)).compositions ?? [];
  const same = sameRequest(request);
  const exact = all.find(
    (c) =>
      sameRequest(c.request) === same &&
      (c.chosen === 'new'
        ? Object.keys(c.pattern).length > 0
        : fingerprint(c.chosen) === c.template),
  );
  const entries = all.filter((c) => c !== exact).map((c) => ({ text: c.request, at: c.at, c }));
  const similar = ranked(entries, request, limit).map(({ c }) => {
    const then = c.thenPattern ? `, then ${c.thenPattern}` : '';
    const how =
      c.chosen === 'new'
        ? `new pattern '${String(c.pattern.name ?? '')}'`
        : `adaptation ${briefly(c.adaptation, 600)}`;
    return `${c.at.slice(0, 10)} | "${c.request.slice(0, 200)}" → ${c.chosen} (complexity ${c.complexity}${then}); ${how}`;
  });
  return { exact, similar };
}
