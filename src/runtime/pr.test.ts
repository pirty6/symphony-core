import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutPr, prForRun, prNumber, repoKey } from './pr.js';

const tmp = mkdtempSync(join(tmpdir(), 'symphony-pr-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })
    .toString()
    .trim();

const ADO = 'https://office@dev.azure.com/o/p/_git/r';

/** An origin with main and a PR whose merge commit it publishes as refs/pull/7/merge. */
function fixture() {
  const origin = join(tmp, 'origin.git');
  const author = join(tmp, 'author');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, author]);
  writeFileSync(join(author, 'a.js'), 'export const a = 1;\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'base');
  git(author, 'push', '-q', 'origin', 'HEAD:main');
  const base = git(author, 'rev-parse', 'HEAD');
  git(author, 'checkout', '-qb', 'feature');
  writeFileSync(join(author, 'a.js'), 'export const a = 2;\n');
  writeFileSync(join(author, 'b.js'), 'export const b = 1;\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'feature');
  git(author, 'checkout', '-q', 'main');
  git(author, 'merge', '-q', '--no-ff', '-m', 'Merge pull request 7', 'feature');
  git(author, 'push', '-q', 'origin', 'HEAD:refs/pull/7/merge');
  // A changed path git would quote without -z.
  git(author, 'checkout', '-qb', 'feature2', 'main');
  writeFileSync(join(author, 'café notes.md'), 'x\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'accent');
  git(author, 'checkout', '-q', 'main');
  git(author, 'merge', '-q', '--no-ff', '-m', 'Merge pull request 9', 'feature2');
  git(author, 'push', '-q', 'origin', 'HEAD:refs/pull/9/merge');
  // The workspace: a clone on another branch, which has never seen the PR. Its origin is an
  // Azure DevOps URL that git rewrites to the local one (url.*.insteadOf), like a real clone.
  const ws = join(tmp, 'ws');
  execFileSync('git', ['clone', '-q', origin, ws]);
  git(ws, 'checkout', '-qb', 'elsewhere');
  git(ws, 'config', `url.${origin}.insteadOf`, ADO);
  git(ws, 'remote', 'set-url', 'origin', ADO);
  return { ws, base };
}

describe('prNumber', () => {
  it('reads Azure DevOps and GitHub links, and PR numbers; never a branch', () => {
    expect(
      prNumber(
        'https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/5952552?path=/x.js&_a=files',
      ),
    ).toBe(5952552);
    expect(prNumber('https://github.com/o/r/pull/42/files')).toBe(42);
    expect(prNumber('PR #12')).toBe(12);
    expect(prNumber('pull request 9')).toBe(9);
    expect(prNumber('#3')).toBe(3);
    for (const t of ['main', 'feature/pr-12', 'HEAD~3..HEAD', 'fix 12 bugs'])
      expect(prNumber(t)).toBeUndefined();
  });
});

describe('repoKey', () => {
  it('names a repository the same way across its URLs', () => {
    const ado = 'ado:office/oc/office-bohemia';
    for (const u of [
      'https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/5952552?_a=files',
      'https://office@dev.azure.com/office/OC/_git/office-bohemia',
      'git@ssh.dev.azure.com:v3/office/OC/office-bohemia',
      'https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia',
    ])
      expect(repoKey(u)).toBe(ado);
    expect(repoKey('https://github.com/pirty6/symphony-core/pull/26')).toBe(
      'gh:pirty6/symphony-core',
    );
    expect(repoKey('git@github.com:pirty6/symphony-core.git')).toBe('gh:pirty6/symphony-core');
    expect(repoKey('/tmp/origin.git')).toBeUndefined();
  });
});

describe('checkoutPr', () => {
  const { ws, base } = fixture();
  const root = join(tmp, 'worktrees');

  it("checks out the PR's merge outside the workspace; its diff is the PR's change", async () => {
    const pr = await checkoutPr(ws, 'https://dev.azure.com/o/p/_git/r/pullrequest/7', { root });
    expect(pr?.info).toEqual({
      number: 7,
      base,
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
      files: ['M\ta.js', 'A\tb.js'],
    });
    expect(pr!.dir!.startsWith(root)).toBe(true);
    // Line endings as git checks them out (CRLF on Windows).
    expect(readFileSync(join(pr!.dir!, 'a.js'), 'utf8').trimEnd()).toBe('export const a = 2;');
    // The workspace is untouched: same branch, same files, no new branch or ref.
    expect(git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('elsewhere');
    expect(readFileSync(join(ws, 'a.js'), 'utf8').trimEnd()).toBe('export const a = 1;');
    // No ref is left behind, and FETCH_HEAD (shared with any other fetch) is not used.
    expect(git(ws, 'for-each-ref', '--format=%(refname)')).not.toMatch(/pull|symphony/);
    expect(existsSync(join(ws, '.git', 'FETCH_HEAD'))).toBe(false);
    await pr!.finish();
    expect(existsSync(pr!.dir!)).toBe(false);
  });

  it('paths come exactly as they are: accents and spaces unquoted', async () => {
    const pr = await checkoutPr(ws, 'PR 9', { root });
    expect(pr?.info).toMatchObject({ files: ['A\tcafé notes.md'] });
    await pr!.finish();
  });

  it("a link to another repository is not this workspace's PR", async () => {
    expect(
      await checkoutPr(ws, 'https://dev.azure.com/o/p/_git/other/pullrequest/7', { root }),
    ).toBeUndefined();
    expect(await checkoutPr(ws, 'https://github.com/o/r/pull/7', { root })).toBeUndefined();
    // The same repository, written another way, is.
    const pr = await checkoutPr(
      ws,
      'https://o.visualstudio.com/DefaultCollection/P/_git/R/pullrequest/7',
      {
        root,
      },
    );
    expect(pr?.info).toMatchObject({ number: 7 });
    await pr!.finish();
  });

  it('a run checks a PR out only when its pattern reads one and a real AI plays it', async () => {
    const review = { checkout: 'target' };
    const ctx = { target: 'PR 7' };
    const real = await prForRun(review, ctx, ws, { provider: 'copilot' });
    expect(real?.info).toMatchObject({ number: 7 });
    await real?.finish();
    expect(await prForRun(review, ctx, ws, { provider: 'scripted' })).toBeUndefined();
    expect(await prForRun({}, ctx, ws, { provider: 'copilot' })).toBeUndefined();
    expect(await prForRun(review, { target: 'main' }, ws, { provider: 'copilot' })).toBeUndefined();
  });

  it('a PR that cannot be fetched says why; a target that is no PR is left alone', async () => {
    const missing = await checkoutPr(ws, 'PR 8', { root });
    expect(missing?.dir).toBeUndefined();
    expect(missing?.info).toMatchObject({
      number: 8,
      error: expect.stringMatching(/could not fetch refs\/pull\/8\/merge from 'origin'/),
    });
    expect(await checkoutPr(ws, 'main', { root })).toBeUndefined();
  });
});
