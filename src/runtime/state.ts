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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** A setting from `env`, else from this process (an env given for one part never loses it). */
const setting = (env: Env, name: string) => (env[name] ?? process.env[name])?.trim();

/** ~/.symphony, or SYMPHONY_HOME. */
export function symphonyHome(env: Env = process.env): string {
  return setting(env, 'SYMPHONY_HOME') || join(homedir(), '.symphony');
}

/** The path as the file system spells it (case included), so every entry point hashes it alike. */
const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
/** Paths differ only in case on these (a lowercase drive letter from VS Code, a typed path). */
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';

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

/** Move into `to` what `from` has and `to` lacks; a file in both stays where it is. */
function mergeInto(from: string, to: string): void {
  for (const n of readdirSync(from)) {
    const a = join(from, n);
    const b = join(to, n);
    try {
      if (!existsSync(b)) renameSync(a, b);
      else if (statSync(a).isDirectory() && statSync(b).isDirectory()) mergeInto(a, b);
    } catch {
      // Left where it is.
    }
  }
  try {
    rmdirSync(from);
  } catch {
    // Not empty: what clashed stays.
  }
}

/** Where the files go, moving the old folder in when it is idle. */
function place(dir: string, legacy: string, opts: { move?: boolean; now?: number }): string {
  if (!existsSync(legacy)) return dir;
  const here = existsSync(dir);
  if (opts.move === false || recentlyWritten(legacy, opts.now ?? Date.now()))
    return here ? dir : legacy;
  try {
    mkdirSync(dirname(dir), { recursive: true });
    // Moved before, and an older process wrote there since: bring that in too.
    if (here) mergeInto(legacy, dir);
    else renameSync(legacy, dir);
  } catch {
    // Another process moved it first, or another disk: wherever the files are.
    return existsSync(dir) ? dir : legacy;
  }
  return dir;
}

/** One answer per workspace for the life of this process: a run never splits its files. */
const chosen = new Map<string, string>();

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
  const hash = createHash('sha256')
    .update(CASELESS ? path.toLowerCase() : path)
    .digest('hex')
    .slice(0, 10);
  const dir = join(symphonyHome(env), 'workspaces', `${name}-${hash}`);
  const looking = opts.move === false || opts.now !== undefined;
  const key = `${dir}\0${legacy}`;
  const known = looking ? undefined : chosen.get(key);
  if (known) return known;
  const at = place(dir, legacy, opts);
  if (!looking) chosen.set(key, at);
  return at;
}
