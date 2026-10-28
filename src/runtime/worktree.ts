/**
 * Isolation for runs that edit files: each one works in its own git worktree, so
 * several fix/refactor/implement runs can play at once on one workspace without
 * seeing each other's edits or test results.
 *
 * The worktree starts from a snapshot of the workspace as it is (HEAD + your
 * uncommitted and untracked files + links to installed dependencies), committed in
 * the worktree only, so git.diff there shows nothing but the run's own edits. When
 * the run ends, its edits come back as one patch: applied to your workspace when the
 * run succeeded and it applies cleanly, otherwise saved under .symphony/patches.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { EditsResult, Pattern, PerformanceOutcome } from '../core/types.js';

/** True when a pattern changes the workspace to do its job (the engine diffs and runs the tests). */
export function editsFiles(p: Pick<Pattern, 'nodes'>): boolean {
  return p.nodes.some(
    (n) => n.kind === 'tool' && (n.tool === 'git.diff' || n.tool === 'tests.run'),
  );
}

export interface Isolation {
  /** Where the run works: the workspace's place inside the worktree. */
  readonly dir: string;
  /** Bring the edits back (or save them) and remove the worktree. */
  readonly finish: (outcome: PerformanceOutcome) => Promise<EditsResult>;
}

/** Installed dependencies are linked, not copied, so the tests run as they do in the workspace. */
const DEPENDENCY_DIRS = ['node_modules', '.venv', 'venv'];
const AUTHOR = [
  '-c',
  'user.name=Symphony',
  '-c',
  'user.email=symphony@localhost',
  '-c',
  'commit.gpgsign=false',
];

function git(
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8'),
      }),
    );
    child.stdin.end(input ?? '');
  });
}

async function must(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const r = await git(cwd, args, input);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err.trim() || `exit ${r.code}`}`);
  return r.out;
}

/** Remove worktrees that crashed runs left behind (older than a day). */
async function sweep(root: string, top: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  for (const n of names) {
    const s = await stat(join(root, n)).catch(() => undefined);
    if (s && Date.now() - s.mtimeMs > 86_400_000)
      await rm(join(root, n), { recursive: true, force: true });
  }
  await git(top, ['worktree', 'prune']);
}

/**
 * A worktree for one run, or undefined when the workspace is not a git repository
 * or SYMPHONY_WORKTREES=off (the run then edits the workspace directly).
 */
export async function isolateRun(
  workspace: string,
  opts: { readonly label: string; readonly env?: NodeJS.ProcessEnv; readonly root?: string },
): Promise<Isolation | undefined> {
  const env = opts.env ?? process.env;
  if (env.SYMPHONY_WORKTREES === 'off') return undefined;
  const top = (
    await git(workspace, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  )?.out.trim();
  // No repository, or one without a commit yet: nothing to branch a worktree from.
  if (!top || (await git(top, ['rev-parse', '--verify', 'HEAD'])).code !== 0) return undefined;

  const root = opts.root ?? join(tmpdir(), 'symphony-worktrees');
  await mkdir(root, { recursive: true });
  await sweep(root, top);
  const id = `${opts.label.replace(/[^\w-]/g, '-')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const wt = join(root, id);
  await must(top, ['worktree', 'add', '--detach', '--quiet', wt, 'HEAD']);

  try {
    // The workspace as it is now: uncommitted changes, untracked files, dependencies.
    const changes = await must(top, ['diff', 'HEAD', '--binary']);
    if (changes) await must(wt, ['apply', '--binary', '--whitespace=nowarn'], changes);
    const untracked = (await must(top, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    for (const f of untracked) {
      await mkdir(dirname(join(wt, f)), { recursive: true });
      await copyFile(join(top, f), join(wt, f)).catch(() => undefined);
    }
    const packages = (await must(top, ['ls-files', '-z', '--', 'package.json', '*/package.json']))
      .split('\0')
      .filter(Boolean)
      .map(dirname);
    for (const d of new Set(['.', ...packages])) {
      for (const name of DEPENDENCY_DIRS) {
        const from = join(top, d, name);
        const to = join(wt, d, name);
        if (existsSync(from) && !existsSync(to)) await symlink(from, to, 'dir');
      }
    }
    await must(wt, ['add', '-A']);
    await must(wt, [
      ...AUTHOR,
      'commit',
      '--quiet',
      '--no-verify',
      '--allow-empty',
      '-m',
      'symphony: workspace snapshot',
    ]);
  } catch (e) {
    await git(top, ['worktree', 'remove', '--force', wt]);
    throw e;
  }

  const remove = async () => {
    if (env.SYMPHONY_KEEP_WORKTREE === '1') return;
    await git(top, ['worktree', 'remove', '--force', wt]);
    await rm(wt, { recursive: true, force: true });
  };

  return {
    // git reports real paths (e.g. /private/var on macOS), so compare real to real.
    dir: join(wt, relative(top, await realpath(workspace))),
    finish: async (outcome) => {
      try {
        await must(wt, ['add', '-A']);
        const patch = await must(wt, ['diff', '--cached', '--binary', 'HEAD']);
        const files = (await must(wt, ['diff', '--cached', '--name-only', 'HEAD']))
          .split('\n')
          .filter(Boolean);
        if (!patch) return { kind: 'unchanged', files: [] };
        if (outcome === 'success') {
          const applied = await git(top, ['apply', '--binary', '--whitespace=nowarn'], patch);
          if (applied.code === 0) return { kind: 'applied', files };
        }
        const dir = join(top, '.symphony', 'patches');
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${id}.patch`);
        await writeFile(file, patch);
        return {
          kind: 'patch',
          files,
          patch: file,
          reason:
            outcome === 'success'
              ? 'your workspace changed in the same places while the run played'
              : `the run ended ${outcome}`,
        };
      } finally {
        await remove();
      }
    },
  };
}

/** isolateRun for a run, with an error that says how to opt out when git refuses. */
export async function isolate(
  workspace: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Isolation | undefined> {
  try {
    return await isolateRun(workspace, { label, env });
  } catch (e) {
    throw new Error(
      `could not give the run its own worktree (${(e as Error).message}); set SYMPHONY_WORKTREES=off to edit the workspace directly`,
      { cause: e },
    );
  }
}
