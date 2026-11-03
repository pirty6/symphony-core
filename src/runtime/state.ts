/**
 * Where Symphony keeps what it makes for a workspace (saved runs, memory, scratch folders,
 * patches it could not apply, eval reports): outside the workspace, so nothing it writes shows
 * in `git status` or can be committed and pushed by accident.
 *
 *   ~/.symphony/workspaces/<folder name>-<hash of its path>/
 *
 * SYMPHONY_HOME moves ~/.symphony. SYMPHONY_STATE=workspace keeps the old layout, a `.symphony`
 * folder inside the workspace. A workspace that still has that folder (from before) has it moved
 * here the first time, so its saved runs and memory follow; while a run may still be writing to
 * it (anything changed in the last 15 minutes), or if it cannot be moved (another disk), the old
 * folder is used as it is.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** A setting from `env`, else from this process (an env given for one part never loses it). */
const setting = (env: Env, name: string) => (env[name] ?? process.env[name])?.trim();

/** ~/.symphony, or SYMPHONY_HOME. */
export function symphonyHome(env: Env = process.env): string {
  return setting(env, 'SYMPHONY_HOME') || join(homedir(), '.symphony');
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** A run still playing (an older Symphony process) may be writing here: do not move it now. */
const ACTIVE_MS = 15 * 60_000;

/** Whether anything in the old folder (two levels down: runs/<pattern>/<file>) changed lately. */
function recentlyWritten(dir: string, now: number, depth = 2): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => {
    const p = join(dir, n);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs < ACTIVE_MS) return true;
      return st.isDirectory() && depth > 0 && recentlyWritten(p, now, depth - 1);
    } catch {
      return false;
    }
  });
}

/**
 * The folder a workspace's Symphony files live in (see the top of this file). `move: false`
 * only looks: it says where the files are now, moving nothing.
 */
export function stateDir(
  workspace: string,
  env: Env = process.env,
  opts: { readonly move?: boolean; readonly now?: number } = {},
): string {
  const legacy = join(workspace, '.symphony');
  if (setting(env, 'SYMPHONY_STATE')?.toLowerCase() === 'workspace') return legacy;
  const path = real(workspace);
  const name = basename(path).replace(/[^\w.-]/g, '-') || 'root';
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 10);
  const dir = join(symphonyHome(env), 'workspaces', `${name}-${hash}`);
  if (!existsSync(dir) && existsSync(legacy)) {
    if (opts.move === false || recentlyWritten(legacy, opts.now ?? Date.now())) return legacy;
    try {
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(legacy, dir);
    } catch {
      // Another disk, or in use: keep reading and writing where the files are.
      return legacy;
    }
  }
  return dir;
}
