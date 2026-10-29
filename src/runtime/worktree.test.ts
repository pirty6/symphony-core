import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { editsFiles, isolateRun } from './worktree.js';
import { fix, implement, investigate, refactor, review } from '../patterns/index.js';

const base = mkdtempSync(join(tmpdir(), 'symphony-wt-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, 'trees');
const env = {};

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repo with one commit, an uncommitted edit, an untracked file and installed deps. */
function repo(name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.symphony/\n');
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  sh(dir, 'init', '-q');
  sh(dir, 'add', '-A');
  sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'a.txt'), 'one\nwork in progress\n');
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '');
  return dir;
}

/** File text with line endings normalized: Windows git checks files out with CRLF. */
const read = (file: string, _enc?: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const status = (dir: string) => sh(dir, 'status', '--porcelain', '--untracked-files=all');

describe('editing runs play in their own worktree', () => {
  it('knows which patterns edit files', () => {
    expect([fix, refactor, implement].every(editsFiles)).toBe(true);
    expect([investigate, review].some(editsFiles)).toBe(false);
  });

  it('starts from the workspace as it is, and its diff shows only the run’s edits', async () => {
    const ws = repo('snapshot');
    const iso = (await isolateRun(ws, { label: 'fix', env, root }))!;
    expect(read(join(iso.dir, 'a.txt'), 'utf8')).toBe('one\nwork in progress\n');
    expect(read(join(iso.dir, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(lstatSync(join(iso.dir, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(iso.dir, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(status(iso.dir)).toBe('');
    writeFileSync(join(iso.dir, 'b.txt'), 'b fixed\n');
    expect(status(iso.dir).trim()).toBe('M b.txt');
    // The workspace does not see the run's edit while it plays.
    expect(read(join(ws, 'b.txt'), 'utf8')).toBe('b\n');
    await iso.finish('cancelled');
  });

  it('a successful run’s edits are applied to the workspace and the worktree removed', async () => {
    const ws = repo('applied');
    const iso = (await isolateRun(ws, { label: 'fix', env, root }))!;
    writeFileSync(join(iso.dir, 'b.txt'), 'b fixed\n');
    writeFileSync(join(iso.dir, 'c.txt'), 'created\n');
    const result = await iso.finish('success');
    expect(result).toEqual({ kind: 'applied', files: ['b.txt', 'c.txt'] });
    expect(read(join(ws, 'b.txt'), 'utf8')).toBe('b fixed\n');
    expect(read(join(ws, 'c.txt'), 'utf8')).toBe('created\n');
    // Your own uncommitted work is untouched.
    expect(read(join(ws, 'a.txt'), 'utf8')).toBe('one\nwork in progress\n');
    expect(existsSync(iso.dir)).toBe(false);
    expect(sh(ws, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('two runs at once do not see each other, and both land', async () => {
    const ws = repo('parallel');
    const one = (await isolateRun(ws, { label: 'fix', env, root }))!;
    const two = (await isolateRun(ws, { label: 'implement', env, root }))!;
    writeFileSync(join(one.dir, 'b.txt'), 'b fixed\n');
    writeFileSync(join(two.dir, 'd.txt'), 'feature\n');
    expect(existsSync(join(one.dir, 'd.txt'))).toBe(false);
    expect(status(two.dir).trim()).toBe('?? d.txt');
    expect((await one.finish('success')).kind).toBe('applied');
    expect((await two.finish('success')).kind).toBe('applied');
    expect(read(join(ws, 'b.txt'), 'utf8')).toBe('b fixed\n');
    expect(read(join(ws, 'd.txt'), 'utf8')).toBe('feature\n');
  });

  it('keeps a patch instead when the run failed or the workspace changed in the same place', async () => {
    const ws = repo('patch');
    const failed = (await isolateRun(ws, { label: 'fix', env, root }))!;
    writeFileSync(join(failed.dir, 'b.txt'), 'half done\n');
    const r1 = await failed.finish('failed');
    expect(r1).toMatchObject({ kind: 'patch', files: ['b.txt'], reason: 'the run ended failed' });
    expect(read(join(ws, 'b.txt'), 'utf8')).toBe('b\n');
    expect(read(r1.patch!, 'utf8')).toMatch(/\+half done/);

    const clash = (await isolateRun(ws, { label: 'fix', env, root }))!;
    writeFileSync(join(clash.dir, 'b.txt'), 'from the run\n');
    writeFileSync(join(ws, 'b.txt'), 'edited by you meanwhile\n');
    const r2 = await clash.finish('success');
    expect(r2.kind).toBe('patch');
    expect(r2.reason).toMatch(/changed in the same places/);
    expect(read(join(ws, 'b.txt'), 'utf8')).toBe('edited by you meanwhile\n');
  });

  it('nothing changed: nothing to apply; and it can be turned off or skipped outside git', async () => {
    const ws = repo('unchanged');
    const iso = (await isolateRun(ws, { label: 'fix', env, root }))!;
    expect(await iso.finish('success')).toEqual({ kind: 'unchanged', files: [] });
    expect(
      await isolateRun(ws, { label: 'fix', env: { SYMPHONY_WORKTREES: 'off' }, root }),
    ).toBeUndefined();
    const plain = mkdtempSync(join(base, 'plain-'));
    expect(await isolateRun(plain, { label: 'fix', env, root })).toBeUndefined();
  });
});
