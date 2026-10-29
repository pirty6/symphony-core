/**
 * Filesystem side of the runtime: workspace fingerprint, run store and
 * user pattern files. Kept out of the pure core on purpose.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { compactPerformance, expandPerformance } from '../core/compact.js';
import { verifyScore } from '../core/compile.js';
import { patternToTypeScript } from '../core/draft.js';
import { hashOf } from '../core/hash.js';
import { migrateRun } from '../core/migrate.js';
import type { Pattern, SavedRun } from '../core/types.js';
import { validatePattern } from '../core/validate.js';
import { repertoireFrom, type Repertoire } from './repertoire.js';

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
  const dir = join(workspace, '.symphony', 'scratch', id);
  await mkdir(dir, { recursive: true });
  const keep = env.SYMPHONY_KEEP_SCRATCH === '1';
  return {
    dir,
    remove: async () => (keep ? undefined : rm(dir, { recursive: true, force: true })),
  };
}

/**
 * Where runs are saved: SYMPHONY_RUNS_DIR (tests point it at a temp folder so
 * their runs never reach your lists), else <root>/.symphony/runs.
 */
export function runsDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SYMPHONY_RUNS_DIR || join(root, '.symphony', 'runs');
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-');

export async function saveRun(dir: string, run: SavedRun): Promise<string> {
  const folder = join(dir, safe(run.score.pattern));
  await mkdir(folder, { recursive: true });
  const stamp = safe(run.performance.startedAt || new Date().toISOString());
  const file = join(folder, `${stamp}-${run.score.id.slice(0, 12)}.json`);
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
  return file;
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
      try {
        const run = JSON.parse(await readFile(file, 'utf8')) as SavedRun;
        out.push({
          file: relative(resolve(dir), file),
          pattern: run.score.pattern,
          goal: run.score.goal,
          scoreId: run.score.id,
          outcome: run.performance.outcome,
          startedAt: run.performance.startedAt,
          steps: run.performance.steps.length,
          demo: isDemoRun(run.performance),
        });
      } catch {
        // skip unreadable files
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
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  demoDays: 7,
  compactDays: 30,
  scratchHours: 24,
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
 * Age is the time since the file was last written.
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
  for (const folder of await entries(dir)) {
    for (const f of await entries(folder.path)) {
      if (!f.path.endsWith('.json')) continue;
      const days = age(f.path, f.age) / DAY;
      if (days < Math.min(policy.demoDays, policy.compactDays)) continue;
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
        if (!opts.dryRun) await rm(f.path, { force: true });
      } else if (days >= policy.compactDays && !run.performance.compacted) {
        const migrated = migrateRun(run).run;
        const small = migrated && compactPerformance(migrated.score, migrated.performance);
        if (!small || !migrated) continue;
        const text = `${JSON.stringify({ ...migrated, performance: small }, null, 2)}\n`;
        compacted.push(name);
        freed += Math.max(0, f.size - text.length);
        if (!opts.dryRun) await writeFile(f.path, text);
      }
    }
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
    return await pruneRuns(runsDir, { scratchDir: join(workspace, '.symphony', 'scratch') });
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

// ── user patterns (TypeScript files) ───────────────────────────────

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
export async function loadRepertoire(runsDir: string): Promise<Repertoire> {
  const summaries = (await listRuns(runsDir)).toReversed();
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
