/**
 * Memory across runs, kept in <workspace>/.symphony/memory.json.
 *
 * - Facts: findings whose citation passed evidence.check ("path:line — fact `quote`").
 *   They are re-checked against the files every time they are recalled, so a fact
 *   about code that has since changed is never offered again.
 * - Lessons: how fix and implement runs ended (root cause and files, or why they
 *   failed), offered to later runs as hints, never as evidence.
 * - Compositions: what the maestro composed for a request and you approved (the
 *   pattern, complexity, and how it was tailored). The same request again reuses
 *   it without a debate; similar ones are offered as precedent.
 *
 * Recall ranks by the words shared with the question; nothing here decides an
 * answer: steps still have to find and cite their own evidence.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkCitations } from './evidence.js';

interface Entry {
  readonly text: string;
  readonly at: string;
  readonly files?: readonly string[];
}

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
  readonly facts: readonly Entry[];
  readonly lessons: readonly Entry[];
  readonly compositions?: readonly Composition[];
}

const MAX_FACTS = 2000;
const MAX_LESSONS = 300;
const MAX_COMPOSITIONS = 200;
const QUOTED_CITATION = /^[\w@./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?\b.*`[^`]{4,}`/;

export const memoryPath = (workspace: string) => join(workspace, '.symphony', 'memory.json');

async function load(workspace: string): Promise<MemoryFile> {
  try {
    const m = JSON.parse(await readFile(memoryPath(workspace), 'utf8')) as Partial<MemoryFile>;
    return { facts: m.facts ?? [], lessons: m.lessons ?? [], compositions: m.compositions ?? [] };
  } catch {
    return { facts: [], lessons: [] };
  }
}

async function save(workspace: string, m: MemoryFile): Promise<void> {
  const file = memoryPath(workspace);
  await mkdir(join(workspace, '.symphony'), { recursive: true });
  // Write then rename, so parallel runs never leave a half-written file.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(m, null, 1)}\n`);
  await rename(tmp, file);
}

/** One update at a time per workspace in this process, so parallel runs add, not overwrite. */
const queues = new Map<string, Promise<unknown>>();
function update(workspace: string, change: (m: MemoryFile) => MemoryFile): Promise<void> {
  const prev = queues.get(workspace) ?? Promise.resolve();
  const next = prev.then(async () => save(workspace, change(await load(workspace))));
  queues.set(
    workspace,
    next.catch(() => undefined),
  );
  return next;
}

/** Keep the newest entries, one per text. */
function merge(old: readonly Entry[], added: readonly Entry[], max: number): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const e of [...added, ...old]) {
    if (seen.has(e.text)) continue;
    seen.add(e.text);
    out.push(e);
  }
  return out.slice(0, max);
}

/** Remember checked findings that quote the file (only those can be re-checked later). */
export async function rememberFacts(
  workspace: string,
  findings: readonly string[],
  at = new Date().toISOString(),
): Promise<number> {
  const facts = findings
    .map((f) => f.replace(/^F\d+\s+/, '').trim())
    .filter((f) => QUOTED_CITATION.test(f))
    .map((text) => ({ text, at }));
  if (facts.length === 0) return 0;
  await update(workspace, (m) => ({ ...m, facts: merge(m.facts, facts, MAX_FACTS) }));
  return facts.length;
}

export async function rememberLesson(
  workspace: string,
  text: string,
  files: readonly string[],
  at = new Date().toISOString(),
): Promise<void> {
  if (!text.trim()) return;
  await update(workspace, (m) => ({
    ...m,
    lessons: merge(m.lessons, [{ text, files, at }], MAX_LESSONS),
  }));
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4),
  );

function ranked<E extends Entry>(entries: readonly E[], query: string, limit: number): E[] {
  const q = words(query);
  return entries
    .map((e, i) => ({
      e,
      i,
      score: [...words(`${e.text} ${(e.files ?? []).join(' ')}`)].filter((w) => q.has(w)).length,
    }))
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

/** Facts that still hold and lessons that share words with the query, best first. */
export async function recall(
  workspace: string,
  query: string,
  limit = 12,
): Promise<{ facts: string[]; lessons: string[] }> {
  const m = await load(workspace);
  // Rank first, then re-check: only facts still true of today's files are offered.
  const candidates = ranked(m.facts, query, limit * 3).map((e) => e.text);
  const still = (await checkCitations(workspace, candidates)).valid.slice(0, limit);
  const lessons = ranked(m.lessons, query, Math.ceil(limit / 2)).map(
    (e) => `${e.at.slice(0, 10)} | ${e.text}`,
  );
  return { facts: still, lessons };
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
