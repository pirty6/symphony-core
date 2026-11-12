/**
 * Filesystem side of the runtime: workspace fingerprint, run store and
 * user pattern files. Kept out of the pure core on purpose.
 */
// Every Node surface (CLI, MCP, studio server) loads the store: hash natively there.
import { scrubbingOn, scrubValue } from '../core/scrub.js';
import './native-hash.js';
import { humanWaits, performanceUsage } from '../core/usage.js';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { compactPerformance, expandPerformance } from '../core/compact.js';
import { verifyScore } from '../core/compile.js';
import { patternToTypeScript } from '../core/draft.js';
import { hashOf } from '../core/hash.js';
import { engineNote, migrateRun } from '../core/migrate.js';
import { replayPerformance } from '../core/replay.js';
import type { Pattern, SavedRun } from '../core/types.js';
import { validatePattern } from '../core/validate.js';
import { repertoireFrom, type Repertoire } from './repertoire.js';
import { stateDir } from './state.js';

const exec = promisify(execFile);

/** hash(HEAD + status + diff); '' outside a git repo. Changes whenever the workspace changes. */
export async function gitFingerprint(cwd: string): Promise<string> {
  const git = async (...args: string[]) =>
    (await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
  try {
    const [head, status, diff, untracked] = await Promise.all([
      git('rev-parse', 'HEAD').catch(() => ''),
      git('status', '--porcelain'),
      git('diff', 'HEAD').catch(() => git('diff')),
      git('ls-files', '--others', '--exclude-standard'),
    ]);
    const files = untracked.split('\n').filter(Boolean);
    const blobs = files.length > 0 ? await git('hash-object', '--', ...files) : '';
    return hashOf({ head: head.trim(), status, diff, untracked: blobs });
  } catch {
    return '';
  }
}

// ── runs ───────────────────────────────────────────────────────────

export interface RunSummary {
  readonly file: string;
  readonly pattern: string;
  readonly goal: string;
  readonly scoreId: string;
  readonly outcome: string;
  readonly startedAt: string;
  readonly steps: number;
  /** Played by the offline demo (canned answers): hidden from recent lists by default. */
  readonly demo: boolean;
  /** What the run cost, rejected attempts included (absent when nothing was reported). */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly calls: number;
    readonly premiumRequests?: number;
  };
  /**
   * Start to end, in ms; null when it cannot be told (no end yet, or it continued another
   * run). Absent in summaries written before it was recorded.
   */
  readonly durationMs?: number | null;
  /** Of that, the time it waited for a person to answer an approval. */
  readonly waitMs?: number;
}

/**
 * Played by the offline demo: the run says so, or (older runs) every AI answer
 * it recorded came from the scripted provider.
 */
export function isDemoRun(perf: Pick<SavedRun['performance'], 'provider' | 'steps'>): boolean {
  if (perf.provider) return perf.provider === 'scripted';
  const players = perf.steps.flatMap((s) => [
    ...(s.transcript ? [s.transcript.provider] : []),
    ...(s.attempts ?? []).flatMap((a) => (a.transcript ? [a.transcript.provider] : [])),
  ]);
  return players.length > 0 && players.every((p) => p === 'scripted');
}

/**
 * A run's scratch folder under <workspace>/.symphony/scratch: executors write
 * temporary scripts and output there, and it is removed when the run ends
 * unless SYMPHONY_KEEP_SCRATCH=1. Never part of the edit (git.diff ignores .symphony).
 */
export async function runScratch(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ dir: string; remove: () => Promise<void> }> {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(stateDir(workspace, env), 'scratch', id);
  await mkdir(dir, { recursive: true });
  const keep = env.SYMPHONY_KEEP_SCRATCH === '1';
  return {
    dir,
    remove: async () => (keep ? undefined : rm(dir, { recursive: true, force: true })),
  };
}

/**
 * Where runs are saved: SYMPHONY_RUNS_DIR (tests point it at a temp folder so
 * their runs never reach your lists), else the workspace's Symphony folder, outside it
 * (src/runtime/state.ts): saved runs stay on this machine, never in the repository.
 */
export function runsDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SYMPHONY_RUNS_DIR || join(stateDir(root, env), 'runs');
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-');

export async function saveRun(
  dir: string,
  given: SavedRun,
  opts: { readonly compact?: boolean } = {},
): Promise<string> {
  // A last scrub of the record where it is written (an error's text, a reason): the engine's
  // state is clean already, so its hashes still hold. The score is not touched: its id is its hash.
  const run = scrubbingOn() ? { ...given, performance: scrubValue(given.performance) } : given;
  const folder = join(dir, safe(run.score.pattern));
  await mkdir(folder, { recursive: true });
  const stamp = safe(run.performance.startedAt || new Date().toISOString());
  const file = join(folder, `${stamp}-${run.score.id.slice(0, 12)}.json`);
  // A checkpoint is rewritten after every step until the final save: unindented, faster.
  await writeWhole(file, `${opts.compact ? JSON.stringify(run) : JSON.stringify(run, null, 2)}\n`);
  await writeWhole(summaryFile(file), JSON.stringify(summaryOf(run)));
  return file;
}

/**
 * Write a file whole or not at all: a process ended mid-write (seen live: VS Code restarted a
 * chat's MCP server during a checkpoint) left a run's only record empty. A rename replaces it at once.
 */
async function writeWhole(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function loadRun(
  file: string,
): Promise<{ run: SavedRun; issues: string[]; migrated: readonly string[] }> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const m = migrateRun(raw);
  // An unreadable format is still returned as-is so callers can show what it is.
  const loaded = m.run ?? (raw as SavedRun);
  // A compacted run gets its timeline back by replaying its recorded answers.
  const run =
    m.run && loaded.performance.compacted
      ? { ...loaded, performance: expandPerformance(loaded.score, loaded.performance) }
      : loaded;
  const issues = m.run ? verifyScore(run.score).map((i) => i.message) : [...m.issues];
  if (run.performance?.scoreId !== run.score?.id)
    issues.push('performance.scoreId does not match score.id');
  return { run, issues, migrated: m.migrated };
}

/**
 * Each saved run has its summary next to it (`<run>.summary`), so listing runs
 * reads a few hundred bytes per run instead of parsing every run in full (long
 * runs reach hundreds of MB, and parsing them all ran the studio out of memory).
 */
export const summaryFile = (file: string): string => file.replace(/\.json$/, '.summary');

function summaryOf(run: SavedRun): Omit<RunSummary, 'file'> {
  return {
    pattern: run.score.pattern,
    goal: run.score.goal,
    scoreId: run.score.id,
    outcome: run.performance.outcome,
    startedAt: run.performance.startedAt,
    steps: run.performance.steps.length,
    demo: isDemoRun(run.performance),
    ...usageSummary(run),
    ...timing(run.performance),
  };
}

function timing(perf: SavedRun['performance']): Pick<RunSummary, 'durationMs' | 'waitMs'> {
  const start = Date.parse(perf.startedAt);
  const end = Date.parse(perf.completedAt ?? '');
  // A continued run started long before it was continued: its span says nothing.
  if (perf.basedOn || !Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return { durationMs: null };
  const waitMs = humanWaits(perf).reduce((n, w) => n + w.ms, 0);
  return { durationMs: end - start, ...(waitMs ? { waitMs } : {}) };
}

function usageSummary(run: SavedRun): Pick<RunSummary, 'usage'> {
  const u = performanceUsage(run.performance).total;
  if (!u.calls) return {};
  return {
    usage: {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      calls: u.calls,
      ...(u.premiumRequests ? { premiumRequests: u.premiumRequests } : {}),
    },
  };
}

/** Whether replaying a run's recorded answers reproduces it, for the run file as it was then. */
export interface ReplayCheck {
  readonly reproduced: boolean;
  /** When it does not: whether another engine version recorded it. */
  readonly note?: string;
  /** The run file's modification time when checked: a rewritten run is checked again. */
  readonly mtimeMs: number;
}

type StoredSummary = Omit<RunSummary, 'file'> & { readonly check?: ReplayCheck };

/** The run's summary, unless it is missing or older than the run (rewritten since). */
async function readSummary(file: string): Promise<StoredSummary | undefined> {
  try {
    const [run, summary] = await Promise.all([stat(file), stat(summaryFile(file))]);
    if (summary.mtimeMs < run.mtimeMs) return undefined;
    return JSON.parse(await readFile(summaryFile(file), 'utf8')) as StoredSummary;
  } catch {
    return undefined;
  }
}

/** The replay check recorded for this run file, if it was checked since it last changed. */
export async function cachedReplayCheck(file: string): Promise<ReplayCheck | undefined> {
  const [summary, now] = await Promise.all([
    readSummary(file),
    stat(file).then(
      (s) => s.mtimeMs,
      () => undefined,
    ),
  ]);
  return summary?.check && summary.check.mtimeMs === now ? summary.check : undefined;
}

/**
 * Replay a saved run's recorded answers and record whether it reproduces. Long
 * runs take seconds, so the verdict is kept in the run's summary and reused
 * until the run file changes.
 */
export async function checkReplay(file: string, run: SavedRun): Promise<ReplayCheck> {
  const cached = await cachedReplayCheck(file);
  if (cached) return cached;
  const mtimeMs = (await stat(file)).mtimeMs;
  const reproduced = replayPerformance(run.score, run.performance).divergence.reproduced;
  const note = reproduced ? undefined : engineNote(run.performance.engine);
  const check: ReplayCheck = { reproduced, mtimeMs, ...(note ? { note } : {}) };
  const summary = (await readSummary(file)) ?? summaryOf(run);
  await writeFile(summaryFile(file), JSON.stringify({ ...summary, check })).catch(() => undefined);
  return check;
}

/** Larger runs are not parsed just to add a duration to their summary. */
const BACKFILL_MAX_BYTES = 32 * 1024 * 1024;

export async function listRuns(dir: string): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  let folders: string[] = [];
  try {
    folders = await readdir(dir);
  } catch {
    return out;
  }
  for (const folder of folders) {
    let files: string[] = [];
    try {
      files = (await readdir(join(dir, folder))).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(dir, folder, f);
      const name = relative(resolve(dir), file);
      const known = await readSummary(file);
      // Summaries written before durations were recorded get them once, unless the run is huge.
      const backfill =
        known && !('durationMs' in known)
          ? await stat(file).then(
              (s) => s.size <= BACKFILL_MAX_BYTES,
              () => false,
            )
          : !known;
      if (known && !backfill) {
        const { check: _check, ...summary } = known;
        out.push({ file: name, ...summary });
        continue;
      }
      try {
        // Older runs (or ones rewritten since): read once, and keep the summary for next time.
        const summary = summaryOf(JSON.parse(await readFile(file, 'utf8')) as SavedRun);
        out.push({ file: name, ...summary });
        const stored = known?.check ? { ...summary, check: known.check } : summary;
        await writeFile(summaryFile(file), JSON.stringify(stored)).catch(() => undefined);
      } catch {
        // An unreadable run is listed from its summary, if it has one.
        if (known) {
          const { check: _check, ...summary } = known;
          out.push({ file: name, ...summary });
        }
      }
    }
  }
  return out.toSorted((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

// ── retention ──────────────────────────────────────────────────────

export interface RetentionPolicy {
  /** Demo runs older than this are deleted. */
  readonly demoDays: number;
  /** Real runs older than this are compacted (compact.ts): AI text dropped, still replayable. */
  readonly compactDays: number;
  /** Scratch folders left by crashed runs older than this are deleted. */
  readonly scratchHours: number;
  /**
   * The runs folder's bound: above this many MB, the oldest real runs are compacted early
   * (still replayable; never deleted), down to it if possible.
   */
  readonly storeMB: number;
  /** Real runs younger than this are kept whole even above storeMB (their AI text to read). */
  readonly keepWholeDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  demoDays: 7,
  compactDays: 30,
  scratchHours: 24,
  storeMB: 500,
  keepWholeDays: 3,
};

export interface PruneReport {
  readonly deleted: readonly string[];
  readonly compacted: readonly string[];
  readonly scratch: readonly string[];
  /** Bytes freed (estimated on a dry run). */
  readonly freed: number;
}

const DAY = 86_400_000;

async function entries(dir: string): Promise<{ path: string; size: number; age: number }[]> {
  const now = Date.now();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: { path: string; size: number; age: number }[] = [];
  for (const n of names) {
    const s = await stat(join(dir, n)).catch(() => undefined);
    if (s) out.push({ path: join(dir, n), size: s.size, age: now - s.mtimeMs });
  }
  return out;
}

/**
 * Keep saved runs from piling up: delete old demo runs, compact old real runs (only
 * when they still replay exactly) and remove scratch folders that crashed runs left.
 * Above storeMB, the oldest real runs are compacted early. Age is the time since the
 * file was last written.
 */
export async function pruneRuns(
  dir: string,
  opts: {
    readonly policy?: Partial<RetentionPolicy>;
    readonly scratchDir?: string;
    readonly dryRun?: boolean;
    readonly age?: (file: string, mtimeAge: number) => number;
  } = {},
): Promise<PruneReport> {
  const policy = { ...DEFAULT_RETENTION, ...opts.policy };
  const age = opts.age ?? ((_f: string, a: number) => a);
  const deleted: string[] = [];
  const compacted: string[] = [];
  const scratch: string[] = [];
  let freed = 0;
  let total = 0;
  /** Real runs that may be compacted early if the folder is over its bound. */
  const early: { path: string; name: string; size: number; days: number }[] = [];
  const compact = async (path: string, name: string, size: number, run: SavedRun) => {
    const migrated = migrateRun(run).run;
    const small = migrated && compactPerformance(migrated.score, migrated.performance);
    if (!small || !migrated) return;
    const text = `${JSON.stringify({ ...migrated, performance: small }, null, 2)}\n`;
    compacted.push(name);
    freed += Math.max(0, size - text.length);
    if (!opts.dryRun) await writeFile(path, text);
  };
  for (const folder of await entries(dir)) {
    for (const f of await entries(folder.path)) {
      if (!f.path.endsWith('.json')) continue;
      total += f.size;
      const days = age(f.path, f.age) / DAY;
      if (days < Math.min(policy.demoDays, policy.compactDays, policy.keepWholeDays)) continue;
      let run: SavedRun;
      try {
        run = JSON.parse(await readFile(f.path, 'utf8')) as SavedRun;
      } catch {
        continue;
      }
      const name = relative(resolve(dir), f.path);
      if (isDemoRun(run.performance)) {
        if (days < policy.demoDays) continue;
        deleted.push(name);
        freed += f.size;
        if (!opts.dryRun) {
          await rm(f.path, { force: true });
          await rm(summaryFile(f.path), { force: true });
        }
      } else if (!run.performance.compacted) {
        if (days >= policy.compactDays) await compact(f.path, name, f.size, run);
        // Only where it is: read again if it is compacted (a big store would not fit in memory).
        else if (days >= policy.keepWholeDays) early.push({ ...f, name, days });
      }
    }
  }
  // Over the bound: the oldest first, until it fits (or nothing old enough is left).
  for (const e of early.toSorted((a, b) => b.days - a.days)) {
    if (total - freed <= policy.storeMB * 1_000_000) break;
    const run = await readFile(e.path, 'utf8')
      .then((t) => JSON.parse(t) as SavedRun)
      .catch(() => undefined);
    if (run) await compact(e.path, e.name, e.size, run);
  }
  if (opts.scratchDir) {
    for (const d of await entries(opts.scratchDir)) {
      if (age(d.path, d.age) < policy.scratchHours * 3_600_000) continue;
      scratch.push(d.path);
      if (!opts.dryRun) await rm(d.path, { recursive: true, force: true });
    }
  }
  return { deleted, compacted, scratch, freed };
}

/**
 * Prune at most once a day (a marker file in the runs folder records the last time).
 * SYMPHONY_RETENTION=off turns it off. Never throws.
 */
export async function autoPrune(
  workspace: string,
  runsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PruneReport | undefined> {
  if (env.SYMPHONY_RETENTION === 'off') return undefined;
  const marker = join(runsDir, '.last-prune');
  try {
    const last = await stat(marker).catch(() => undefined);
    if (last && Date.now() - last.mtimeMs < DAY) return undefined;
    await mkdir(runsDir, { recursive: true });
    await writeFile(marker, `${new Date().toISOString()}\n`);
    return await pruneRuns(runsDir, { scratchDir: join(stateDir(workspace, env), 'scratch') });
  } catch {
    return undefined;
  }
}

/** Resolve a run file inside `dir`, refusing paths that escape it. */
export function runPath(dir: string, file: string): string | undefined {
  const full = resolve(dir, file);
  // relative() works with either separator (a '/' prefix check refused every run on Windows).
  const inside = relative(resolve(dir), full);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) && full.endsWith('.json')
    ? full
    : undefined;
}

/** Delete one saved run inside `dir`. False when the path is outside it or there is no such run. */
export async function deleteRun(dir: string, file: string): Promise<boolean> {
  const full = runPath(dir, file);
  if (!full) return false;
  try {
    if (!(await stat(full)).isFile()) return false;
  } catch {
    return false;
  }
  await rm(full);
  await rm(summaryFile(full), { force: true });
  return true;
}

// ── user patterns (TypeScript files) ───────────────────────────────

/** Where saved patterns go in a symphony-core checkout; the studio and CLI list them. */
export const DRAFTS_DIR = 'src/patterns/drafts';

export async function savePatternFile(
  dir: string,
  pattern: Pattern,
  typesImport: string,
): Promise<string> {
  const report = validatePattern(pattern);
  if (report.errors.length > 0) throw new Error(report.errors.map((e) => e.message).join('; '));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${safe(pattern.name)}.ts`);
  const source = patternToTypeScript(pattern).replace("'../core/types.js'", `'${typesImport}'`);
  await writeFile(file, source);
  return file;
}

export async function loadPatternFiles(
  dir: string,
  importer: (file: string) => Promise<Record<string, unknown>>,
): Promise<Pattern[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .toSorted();
  } catch {
    return [];
  }
  const patterns: Pattern[] = [];
  for (const f of files) {
    try {
      const mod = await importer(join(dir, f));
      for (const v of Object.values(mod)) {
        const p = v as Pattern;
        if (p && typeof p === 'object' && typeof p.name === 'string' && Array.isArray(p.nodes)) {
          if (validatePattern(p).errors.length === 0) patterns.push(p);
        }
      }
    } catch {
      // ignore broken files; they show up as missing in the library
    }
  }
  return patterns;
}

/** Load every saved run, oldest first, so the first performance of a song is the one replayed. */
/**
 * The recorded answers a run of this score can replay. Answers are found by score id, so with
 * `scoreId` only that score's runs are read: not every saved run (a store of 1.1 GB was parsed
 * whole at the default improvisation before).
 */
export async function loadRepertoire(runsDir: string, scoreId?: string): Promise<Repertoire> {
  const summaries = (await listRuns(runsDir))
    .filter((s) => scoreId === undefined || s.scoreId === scoreId)
    .toReversed();
  const runs: { run: SavedRun; file: string }[] = [];
  for (const s of summaries) {
    try {
      runs.push({
        run: JSON.parse(await readFile(join(runsDir, s.file), 'utf8')) as SavedRun,
        file: s.file,
      });
    } catch {
      // unreadable runs are skipped
    }
  }
  return repertoireFrom(runs);
}
