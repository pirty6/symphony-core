/**
 * A pull request checked out for a run that reads it (review): the PR's merge commit, which
 * GitHub and Azure DevOps both publish as refs/pull/<n>/merge, fetched with the user's own git
 * credentials and checked out in a temporary worktree outside the workspace. The run plays
 * there, so the diff, the files the AI reads and the citations it makes are the PR's own,
 * whatever branch the workspace is on. No AI step needs network or CLI access for it. A review of
 * a branch that is not checked out plays in a worktree of that branch the same way.
 */
import { spawn } from 'node:child_process';
import { signInFreeEnv, signInsOff } from './signins.js';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Pattern, PrInfo } from '../core/types.js';

export type { PrInfo };
import { git, linkDependencies, must, sweep } from './worktree.js';

export interface PrCheckout {
  readonly info: PrInfo;
  /** Where the run plays (the workspace's place in the worktree); absent when it failed. */
  readonly dir?: string;
  readonly finish: () => Promise<void>;
}

/**
 * The PR a target names: an Azure DevOps (…/pullrequest/123) or GitHub (…/pull/123) link,
 * "PR 123", "PR #123", "pull request 123" or "#123". Branch names and ranges are not PRs.
 */
export function prNumber(target: string): number | undefined {
  const t = target.trim();
  const m =
    /\/pullrequest\/(\d+)\b/i.exec(t) ??
    /\/pull\/(\d+)\b/i.exec(t) ??
    /^(?:pr|pull request)\s*#?\s*(\d+)$/i.exec(t) ??
    /^#(\d+)$/.exec(t);
  return m ? Number(m[1]) : undefined;
}

const strip = (repo: string) => repo.replace(/[.]git$/, '');

/**
 * The repository a URL names, comparable across https and ssh forms: "ado:org/project/repo"
 * (dev.azure.com, *.visualstudio.com, ssh.dev.azure.com) or "gh:owner/repo". Lower case: Azure
 * DevOps names are case-insensitive.
 */
export function repoKey(url: string): string | undefined {
  const u = url.trim().toLowerCase();
  const ado =
    /dev[.]azure[.]com[/]([^/]+)[/]([^/]+)[/]_git[/]([^/?#]+)/.exec(u) ??
    /ssh[.]dev[.]azure[.]com:v3[/]([^/]+)[/]([^/]+)[/]([^/?#]+)/.exec(u) ??
    /([^/.@]+)[.]visualstudio[.]com[/](?:defaultcollection[/])?([^/]+)[/]_git[/]([^/?#]+)/.exec(u);
  if (ado) return `ado:${ado[1]}/${ado[2]}/${strip(ado[3]!)}`;
  const gh = /github[.]com[/:]([^/]+)[/]([^/?#]+)/.exec(u);
  if (gh) return `gh:${gh[1]}/${strip(gh[2]!)}`;
  return undefined;
}

const FETCH_TIMEOUT_MS = 300_000;

/**
 * Fetch and check out the PR a target names, or undefined when it names none (or the
 * workspace is not a git repository). A PR that cannot be fetched returns its error, so the
 * run can say why it could not review instead of reviewing the wrong code.
 */
export async function checkoutPr(
  workspace: string,
  target: string,
  opts: { readonly env?: NodeJS.ProcessEnv; readonly root?: string } = {},
): Promise<PrCheckout | undefined> {
  const number = prNumber(target);
  if (number === undefined) return undefined;
  const top = (
    await git(workspace, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  )?.out.trim();
  if (!top) return undefined;
  const failed = (error: string): PrCheckout => ({
    info: { number, error },
    finish: async () => {},
  });
  const remote = await chooseRemote(top, repoKey(target));
  // A link to a repository this workspace has no remote for: not ours to check out.
  if (remote === null) return undefined;
  if (!remote) return failed('the workspace has no git remote to fetch the PR from');
  const fetched = await fetchRef(top, remote, `refs/pull/${number}/merge`, opts.env);
  if (!fetched.ok)
    return failed(
      `could not fetch refs/pull/${number}/merge from '${remote}' (${fetched.error}). The PR may be closed, have merge conflicts, or need you to sign in to git for this remote`,
    );
  const head = fetched.sha;
  const root = opts.root ?? join(tmpdir(), 'symphony-worktrees');
  const wt = join(
    root,
    `pr-${number}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
  );
  const remove = async () => {
    await git(top, ['worktree', 'remove', '--force', wt]);
    await rm(wt, { recursive: true, force: true });
  };
  try {
    const base = (await git(top, ['rev-parse', '--verify', '--quiet', `${head}^1`])).out.trim();
    if (!base) return failed(`refs/pull/${number}/merge is not a merge commit`);
    await mkdir(root, { recursive: true });
    await sweep(root, top);
    await must(top, ['worktree', 'add', '--detach', '--quiet', wt, head]);
    await linkDependencies(top, wt).catch(() => undefined);
    // -z: paths exactly as they are (no quoting of spaces, accents or tabs).
    const fields = (await must(wt, ['diff', '--name-status', '--no-renames', '-z', base, 'HEAD']))
      .split('\0')
      .filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) files.push(`${fields[i]}\t${fields[i + 1]}`);
    const env = opts.env ?? process.env;
    return {
      info: { number, base, head, files },
      dir: join(wt, relative(top, await realpath(workspace))),
      finish: async () => {
        if (env.SYMPHONY_KEEP_WORKTREE !== '1') await remove();
      },
    };
  } catch (e) {
    await remove().catch(() => undefined);
    throw e;
  } finally {
    // The worktree holds the commit now: the private ref the fetch made is not needed.
    await git(top, ['update-ref', '-d', fetched.ref]);
  }
}

/**
 * The PR checkout for a run, when its pattern reads a PR (Pattern.checkout) and that input
 * names one. Only for a real AI: scripted demos play on the workspace as it is.
 */
export async function prForRun(
  pattern: Pick<Pattern, 'checkout'>,
  context: Readonly<Record<string, unknown>>,
  workspace: string,
  opts: { readonly provider: string; readonly env?: NodeJS.ProcessEnv },
): Promise<Checkout | undefined> {
  const target = pattern.checkout ? context[pattern.checkout] : undefined;
  if (opts.provider !== 'copilot' || typeof target !== 'string') return undefined;
  // Without sign-ins, the fetch uses none of your credentials: a private repository's PR fails.
  const base = opts.env ?? process.env;
  const env = signInsOff(base) ? signInFreeEnv(base) : opts.env;
  const pr = await checkoutPr(workspace, target, env ? { env } : {});
  return pr ?? checkoutBranch(workspace, target, env ? { env } : {});
}

/** Where a run plays: a PR's checkout (with what was fetched), or a branch's. */
export interface Checkout {
  readonly info?: PrInfo;
  readonly dir?: string;
  readonly finish: () => Promise<void>;
}

/**
 * A branch a review names that is not what the workspace has checked out (local, on a remote,
 * or fetched from one), in a temporary worktree: the files the AI reads and the quotes it cites
 * are that branch's, not the workspace's. Undefined when the target is no branch, or is HEAD.
 */
export async function checkoutBranch(
  workspace: string,
  target: string,
  opts: { readonly env?: NodeJS.ProcessEnv; readonly root?: string } = {},
): Promise<Checkout | undefined> {
  const name = target.trim();
  // A range, a path or prose is no branch name.
  if (!name || /\.\.|\s|^-/.test(name) || prNumber(name) !== undefined) return undefined;
  const top = (
    await git(workspace, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  )?.out.trim();
  if (!top) return undefined;
  const commit = async (ref: string) =>
    (await git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).out.trim() ||
    undefined;
  const remotes = (await git(top, ['remote'])).out.split('\n').filter(Boolean);
  let sha = await commit(name);
  for (const r of remotes) sha ??= await commit(`${r}/${name}`);
  let fetchedRef: string | undefined;
  if (!sha) {
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    const got = remote ? await fetchRef(top, remote, `refs/heads/${name}`, opts.env) : undefined;
    if (got?.ok) {
      [sha, fetchedRef] = [got.sha, got.ref];
      // What a plain git fetch leaves: the branch is <remote>/<name> to the AI's git commands.
      await git(top, ['update-ref', `refs/remotes/${remote}/${name}`, sha]);
    }
  }
  if (!sha || sha === (await commit('HEAD'))) return undefined;
  const root = opts.root ?? join(tmpdir(), 'symphony-worktrees');
  const wt = join(root, `branch-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
  const remove = async () => {
    await git(top, ['worktree', 'remove', '--force', wt]);
    await rm(wt, { recursive: true, force: true });
  };
  try {
    await mkdir(root, { recursive: true });
    await sweep(root, top);
    await must(top, ['worktree', 'add', '--detach', '--quiet', wt, sha]);
    await linkDependencies(top, wt).catch(() => undefined);
    const env = opts.env ?? process.env;
    return {
      dir: join(wt, relative(top, await realpath(workspace))),
      finish: async () => {
        if (env.SYMPHONY_KEEP_WORKTREE !== '1') await remove();
      },
    };
  } catch (e) {
    await remove().catch(() => undefined);
    throw e;
  } finally {
    if (fetchedRef) await git(top, ['update-ref', '-d', fetchedRef]);
  }
}

/**
 * The remote to fetch from: for a link, the one that is the linked repository (null when none
 * is: the link is to another repository); otherwise origin, else the only remote.
 */
async function chooseRemote(
  top: string,
  want: string | undefined,
): Promise<string | null | undefined> {
  const remotes = (await git(top, ['remote'])).out.split('\n').filter(Boolean);
  if (want) {
    for (const r of remotes) {
      // As written, and with url.*.insteadOf applied: either may be the repository's URL.
      const raw = (await git(top, ['config', '--get', `remote.${r}.url`])).out.trim();
      const url = (await git(top, ['remote', 'get-url', r])).out.trim();
      if (repoKey(raw) === want || repoKey(url) === want) return r;
    }
    return null;
  }
  return remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
}

/**
 * Fetch one ref into a private ref of this run (never FETCH_HEAD, which any other fetch, yours
 * or your editor's, may overwrite in between) and read its commit. The caller deletes `ref`.
 */
async function fetchRef(
  top: string,
  remote: string,
  ref: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ ok: true; sha: string; ref: string } | { ok: false; error: string }> {
  const mine = `refs/symphony/pr-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const r = await gitWithTimeout(
    top,
    ['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote, `+${ref}:${mine}`],
    { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
    FETCH_TIMEOUT_MS,
  );
  const sha =
    r.code === 0 ? (await git(top, ['rev-parse', '--verify', '--quiet', mine])).out.trim() : '';
  if (sha) return { ok: true, sha, ref: mine };
  await git(top, ['update-ref', '-d', mine]);
  return {
    ok: false,
    error: r.code === 0 ? 'nothing fetched' : r.err.trim().split('\n').at(-1) || `exit ${r.code}`,
  };
}

async function gitWithTimeout(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  ms: number,
): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr.on('data', (b: Buffer) => err.push(b));
    const timer = setTimeout(() => child.kill(), ms);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, err: e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        err: signal ? `timed out after ${ms / 1000} s` : Buffer.concat(err).toString('utf8'),
      });
    });
  });
}
