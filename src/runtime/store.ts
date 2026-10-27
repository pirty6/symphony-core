/**
 * Filesystem side of the runtime: workspace fingerprint, run store and
 * user pattern files. Kept out of the pure core on purpose.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { verifyScore } from '../core/compile.js';
import { patternToTypeScript } from '../core/draft.js';
import { hashOf } from '../core/hash.js';
import type { Pattern, SavedRun } from '../core/types.js';
import { validatePattern } from '../core/validate.js';

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

export async function loadRun(file: string): Promise<{ run: SavedRun; issues: string[] }> {
  const run = JSON.parse(await readFile(file, 'utf8')) as SavedRun;
  const issues =
    run.schemaVersion === 2
      ? verifyScore(run.score).map((i) => i.message)
      : ['not a schemaVersion 2 run'];
  if (run.performance?.scoreId !== run.score?.id)
    issues.push('performance.scoreId does not match score.id');
  return { run, issues };
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
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  return out.toSorted((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Resolve a run file inside `dir`, refusing paths that escape it. */
export function runPath(dir: string, file: string): string | undefined {
  const full = resolve(dir, file);
  return full.startsWith(resolve(dir) + '/') && full.endsWith('.json') ? full : undefined;
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
