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
 * Hygiene: facts are stored without the run's own annotations ("[H2 against]"),
 * one per path:line (the newest), and one run may add at most MAX_FACTS_PER_RUN,
 * so a few big runs cannot replace the whole store. Lessons whose files are gone,
 * or older than LESSON_DAYS, are not recalled.
 *
 * Recall ranks by the words shared with the question, rarer words weighing more;
 * nothing here decides an answer: steps still have to find and cite their own evidence.
 */
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkCitations } from './evidence.js';

interface Entry {
  readonly text: string;
  readonly at: string;
  readonly files?: readonly string[];
  /** The run that added it (facts), so one run's share can be capped. */
  readonly run?: string;
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
/** At most this many facts from one run: a tenth of the store. */
export const MAX_FACTS_PER_RUN = 200;
/** Lessons older than this are not recalled. */
export const LESSON_DAYS = 90;
const MAX_COMPOSITIONS = 200;
const QUOTED_CITATION = /^[\w@./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?\b.*`[^`]{4,}`/;

export const memoryPath = (workspace: string) => join(workspace, '.symphony', 'memory.json');

/**
 * A fact as stored: without the run's own bracketed annotations ("[H22 against]",
 * "[F3]"), which belong to that run's question; brackets inside the quoted code stay.
 */
export function cleanFact(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s*\[[^\]`]*\]/g, '')))
    .join('')
    .replace(/\s+$/, '')
    .trim();
}

/** "src/a.ts:12" of "src/a.ts:12 — fact `quote`": one fact per place. */
const factKey = (text: string): string => text.split(' — ')[0]!.trim();

/** Clean, then keep the first (newest) fact per path:line. */
function tidyFacts(facts: readonly Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const f of facts) {
    const text = cleanFact(f.text);
    const key = factKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...f, text });
  }
  return out;
}

async function load(workspace: string): Promise<MemoryFile> {
  try {
    const m = JSON.parse(await readFile(memoryPath(workspace), 'utf8')) as Partial<MemoryFile>;
    // Stores written before the hygiene rules are tidied as they are read.
    return {
      facts: tidyFacts(m.facts ?? []),
      lessons: m.lessons ?? [],
      compositions: m.compositions ?? [],
    };
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

/**
 * Remember checked findings that quote the file (only those can be re-checked
 * later), cleaned of run annotations, newest per path:line, at most
 * MAX_FACTS_PER_RUN from one run.
 */
export async function rememberFacts(
  workspace: string,
  findings: readonly string[],
  at = new Date().toISOString(),
  run?: string,
): Promise<number> {
  const facts = findings
    .map((f) => cleanFact(f.replace(/^F\d+\s+/, '')))
    .filter((f) => QUOTED_CITATION.test(f))
    .map((text): Entry => (run ? { text, at, run } : { text, at }));
  if (facts.length === 0) return 0;
  let added = 0;
  await update(workspace, (m) => {
    const room = run
      ? Math.max(0, MAX_FACTS_PER_RUN - m.facts.filter((f) => f.run === run).length)
      : facts.length;
    const kept = facts.slice(0, room);
    added = kept.length;
    return { ...m, facts: tidyFacts(merge(m.facts, kept, MAX_FACTS * 2)).slice(0, MAX_FACTS) };
  });
  return added;
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

/**
 * Entries sharing words with the query, best first. A word counts by its rarity
 * among the entries (inverse document frequency): "error" matches everything,
 * "paginate" says something.
 */
function ranked<E extends Entry>(entries: readonly E[], query: string, limit: number): E[] {
  const q = words(query);
  const bags = entries.map((e) => words(`${e.text} ${(e.files ?? []).join(' ')}`));
  const df = new Map<string, number>();
  for (const bag of bags) for (const w of bag) if (q.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const weight = (w: string) => Math.log(1 + entries.length / (df.get(w) ?? 1));
  return entries
    .map((e, i) => ({
      e,
      i,
      score: [...bags[i]!].filter((w) => q.has(w)).reduce((sum, w) => sum + weight(w), 0),
    }))
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

async function liveLessons(workspace: string, lessons: readonly Entry[]): Promise<Entry[]> {
  const oldest = Date.now() - LESSON_DAYS * 86_400_000;
  const live = await Promise.all(
    lessons.map(async (l) => {
      if (Date.parse(l.at) < oldest) return false;
      const there = await Promise.all(
        (l.files ?? []).map((f) =>
          access(join(workspace, f)).then(
            () => true,
            () => false,
          ),
        ),
      );
      return there.every(Boolean);
    }),
  );
  return lessons.filter((_, i) => live[i]);
}

/**
 * The fact pointed at the line its quote is on now, when the quote moved within the
 * same file and appears there exactly once; otherwise undefined.
 */
export async function reanchor(workspace: string, fact: string): Promise<string | undefined> {
  const at = /^([\w@./-]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?/.exec(fact);
  const quote = /`([^`]{8,})`/.exec(fact)?.[1]?.replace(/\s+/g, ' ').trim();
  if (!at || !quote) return undefined;
  const text = await readFile(join(workspace, at[1]!), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const hits = text
    .split('\n')
    .flatMap((line, i) => (line.replace(/\s+/g, ' ').includes(quote) ? [i + 1] : []));
  return hits.length === 1 ? `${at[1]}:${hits[0]}${fact.slice(at[0].length)}` : undefined;
}

/** Facts that still hold and lessons that share words with the query, best first. */
export async function recall(
  workspace: string,
  query: string,
  limit = 12,
  opts: { readonly store?: string; readonly excludeRun?: string } = {},
): Promise<{ facts: string[]; lessons: string[] }> {
  const m = await load(opts.store ?? workspace);
  // A run's own facts are already in its findings: recalling them is no news.
  const others = opts.excludeRun ? m.facts.filter((f) => f.run !== opts.excludeRun) : m.facts;
  // Rank first, then re-check: only facts still true of today's files are offered.
  const candidates = ranked(others, query, limit * 3).map((e) => e.text);
  const checked = await checkCitations(workspace, candidates);
  // A fact whose quoted line only moved is still true: point it at the line it is on now.
  const moved = new Map<string, string>();
  for (const { finding } of checked.invalid) {
    const now = await reanchor(workspace, finding);
    if (now) moved.set(finding, now);
  }
  const again = moved.size ? (await checkCitations(workspace, [...moved.values()])).valid : [];
  const still = [...checked.valid, ...again].slice(0, limit);
  if (again.length > 0) {
    const fixed = new Map([...moved].filter(([, now]) => again.includes(now)));
    await update(opts.store ?? workspace, (mem) => ({
      ...mem,
      facts: tidyFacts(
        mem.facts.map((f) =>
          fixed.has(f.text) ? Object.assign({}, f, { text: fixed.get(f.text)! }) : f,
        ),
      ),
    })).catch(() => undefined);
  }
  // A lesson about files that are gone, or from long ago, no longer applies.
  const fresh = await liveLessons(workspace, m.lessons);
  const lessons = ranked(fresh, query, Math.ceil(limit / 2)).map(
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
