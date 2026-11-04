/**
 * A pull request checked out for a run that reads it (review): the PR's merge commit, which
 * GitHub and Azure DevOps both publish as refs/pull/<n>/merge, fetched with the user's own git
 * credentials and checked out in a temporary worktree outside the workspace. The run plays
 * there, so the diff, the files the AI reads and the citations it makes are the PR's own,
 * whatever branch the workspace is on. No AI step needs network or CLI access for it.
 */
import { spawn } from 'node:child_process';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { git, linkDependencies, must, sweep } from './worktree.js';

/** What a run knows about the PR it plays on (ToolContext.pr). */
export type PrInfo =
  | {
      readonly number: number;
      /** The target branch's commit the PR merges into: `git diff <base> HEAD` is the PR. */
      readonly base: string;
      readonly head: string;
      /** `git diff --name-status <base> HEAD`, one line per changed file. */
      readonly files: readonly string[];
    }
  | { readonly number: number; readonly error: string };

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
  const remote = await chooseRemote(top);
  if (!remote) return failed('the workspace has no git remote to fetch the PR from');
  const fetched = await fetchRef(top, remote, `refs/pull/${number}/merge`, opts.env);
  if (!fetched.ok)
    return failed(
      `could not fetch refs/pull/${number}/merge from '${remote}' (${fetched.error}). The PR may be closed, have merge conflicts, or need you to sign in to git for this remote`,
    );
  const head = fetched.sha;
  const base = (await git(top, ['rev-parse', `${head}^1`])).out.trim();
  if (!base) return failed(`refs/pull/${number}/merge is not a merge commit`);

  const root = opts.root ?? join(tmpdir(), 'symphony-worktrees');
  await mkdir(root, { recursive: true });
  await sweep(root, top);
  const wt = join(root, `pr-${number}-${Date.now().toString(36)}`);
  await must(top, ['worktree', 'add', '--detach', '--quiet', wt, head]);
  await linkDependencies(top, wt).catch(() => undefined);
  const files = (await must(wt, ['diff', '--name-status', '--no-renames', base, 'HEAD']))
    .split('\n')
    .filter(Boolean);
  const env = opts.env ?? process.env;
  return {
    info: { number, base, head, files },
    dir: join(wt, relative(top, await realpath(workspace))),
    finish: async () => {
      if (env.SYMPHONY_KEEP_WORKTREE === '1') return;
      await git(top, ['worktree', 'remove', '--force', wt]);
      await rm(wt, { recursive: true, force: true });
    },
  };
}

/** origin, else the only remote. */
async function chooseRemote(top: string): Promise<string | undefined> {
  const remotes = (await git(top, ['remote'])).out.split('\n').filter(Boolean);
  return remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
}

/** Fetch one ref without storing it under a name: its commit, read from FETCH_HEAD. */
async function fetchRef(
  top: string,
  remote: string,
  ref: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const r = await gitWithTimeout(
    top,
    ['fetch', '--no-tags', '--quiet', remote, ref],
    { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
    FETCH_TIMEOUT_MS,
  );
  if (r.code !== 0)
    return { ok: false, error: r.err.trim().split('\n').at(-1) || `exit ${r.code}` };
  const sha = (await git(top, ['rev-parse', 'FETCH_HEAD'])).out.trim();
  return sha ? { ok: true, sha } : { ok: false, error: 'nothing fetched' };
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
