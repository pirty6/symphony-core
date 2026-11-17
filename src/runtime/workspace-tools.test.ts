import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  detectTestCommand,
  normalizeOutput,
  runCommand,
  truncateDiff,
  workspaceDiff,
  workspaceTools,
} from './workspace-tools.js';

const tool = (name: string) => workspaceTools().find((t) => t.name === name)!;

const root = mkdtempSync(join(tmpdir(), 'symphony-ws-'));
// Windows can hold a folder a just-finished test command ran in for a moment.
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
let n = 0;
const dir = () => {
  const d = join(root, `w${n++}`);
  execFileSync('git', ['init', '-q', d]);
  return d;
};
const ctx = (workspace: string) => ({
  workspace,
  repoRoot: workspace,
  signal: new AbortController().signal,
});
/** Every file under a folder (the memory file's place is the store's business). */
describe('normalizeOutput', () => {
  it('removes what changes between identical runs', () => {
    const a = normalizeOutput(
      '\x1b[32m✓\x1b[0m 3 passed (412ms)\nStart at 10:01:02\n/var/folders/ab/T/x.ts:3 at 2026-10-28T10:01:02.123Z\n/work/repo/src/a.ts',
      '/work/repo',
    );
    const b = normalizeOutput(
      '\x1b[32m✓\x1b[0m 3 passed (98ms)\nStart at 23:59:59\n/var/folders/zz/T/y.ts:3 at 2026-01-01T00:00:00Z\n/work/repo/src/a.ts',
      '/work/repo',
    );
    expect(a).toBe(b);
    expect(a).toContain('./src/a.ts');
    // oxlint-disable-next-line no-control-regex
    expect(a).not.toMatch(/\x1b|412ms|10:01/);
  });

  it('also removes durations named in the label (node --test)', () => {
    expect(normalizeOutput('ℹ pass 4\nℹ duration_ms 90.747209')).toBe(
      normalizeOutput('ℹ pass 4\nℹ duration_ms 12.5'),
    );
    expect(normalizeOutput('elapsed: 3.2')).toBe('elapsed: <duration>');
  });

  it('keeps the head and tail of long output', () => {
    const out = normalizeOutput(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
    expect(out).toMatch(/^line 0\n/);
    expect(out).toMatch(/line 499$/);
    expect(out).toMatch(/380 lines omitted/);
  });
});

describe('tests.run', () => {
  it('uses the project test script, choosing the package manager from the lockfile', async () => {
    const d = dir();
    expect(await detectTestCommand(d)).toBeUndefined();
    writeFileSync(
      join(d, 'package.json'),
      '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}',
    );
    expect(await detectTestCommand(d)).toBeUndefined();
    writeFileSync(join(d, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    expect(await detectTestCommand(d)).toBe('npm test');
    writeFileSync(join(d, 'pnpm-lock.yaml'), '');
    expect(await detectTestCommand(d)).toBe('pnpm test');
  });

  it('reports failure and timeouts as results, not errors', async () => {
    const d = dir();
    const ok = await runCommand('node -e "console.log(1)"', ctx(d));
    expect(ok).toEqual({ passed: true, output: '1', command: 'node -e "console.log(1)"' });
    const bad = await runCommand('node -e "console.error(\'boom\'); process.exit(3)"', ctx(d));
    expect(bad).toMatchObject({ passed: false, output: 'exit code 3\nboom' });
    const slow = await runCommand('node -e "setTimeout(() => {}, 5000)"', ctx(d), 300);
    expect(slow.passed).toBe(false);
    expect(slow.output).toMatch(/^timed out after 0s/);
  });

  it('a timeout kills everything the command started, not just its shell', async () => {
    const d = dir();
    // A command that starts a grandchild (like a test runner's workers) and waits.
    writeFileSync(
      join(d, 'tree.js'),
      `const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
setInterval(() => {}, 1000);`,
    );
    const r = await runCommand('node tree.js', ctx(d), 1500);
    expect(r.passed).toBe(false);
    expect(r.output).toMatch(/^timed out after 2s/);
    const pid = Number(readFileSync(join(d, 'pid'), 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 20 && alive(); i++) await new Promise((wait) => setTimeout(wait, 100));
    expect(alive()).toBe(false);
  });

  it('needs a command it can find, and never takes one from elsewhere than its input', async () => {
    const d = dir();
    await expect(tool('tests.run').run({}, ctx(d))).rejects.toThrow(/no test command/);
    // For a remote caller nothing runs, and it says so.
    expect(
      await tool('tests.run').run(
        { command: 'node -e "process.exit(1)"' },
        { ...ctx(d), runsCode: false },
      ),
    ).toMatchObject({ passed: true, output: expect.stringMatching(/^not run: remote callers/) });
    // A step that runs the tests only if there are any (review): not run, not a failure.
    expect(await tool('tests.run').run({ optional: true }, ctx(d))).toEqual({
      passed: true,
      output: expect.stringMatching(/^not run: no test command/),
      command: '',
    });
    expect(
      await tool('tests.run').run({ command: 'node -e "process.exit(0)"' }, ctx(d)),
    ).toMatchObject({
      passed: true,
    });
  });
});

// git spawns: 0.2-0.6 s per test alone, over 5 s when the machine is loaded (seen locally and on CI).
describe('tests.run reuse', { timeout: 30_000 }, () => {
  it('a baseline on an unchanged workspace is reused; any change runs it again', async () => {
    const d = dir();
    const counter = join(root, `runs-${n}`);
    writeFileSync(join(d, 'a.txt'), 'one\n');
    const args = { command: `echo ran >> ${counter}`, reuse: true };
    const first = await tool('tests.run').run(args, ctx(d));
    const again = await tool('tests.run').run(args, ctx(d));
    expect(again.output).toMatch(/\(reused: the workspace is unchanged/);
    const runs = () =>
      readFileSync(counter, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim()).length;
    expect(runs()).toBe(1);
    writeFileSync(join(d, 'a.txt'), 'two\n');
    await tool('tests.run').run(args, ctx(d));
    expect(runs()).toBe(2);
    // Without reuse every call runs.
    await tool('tests.run').run({ command: args.command }, ctx(d));
    expect(runs()).toBe(3);
    expect(first.passed).toBe(true);
  });
});

// git spawns: 0.2-0.6 s per test alone, over 5 s when the machine is loaded (seen locally and on CI).
describe('git.diff', { timeout: 30_000 }, () => {
  it('works in a repository with no commits yet', async () => {
    const d = dir();
    const before = await workspaceDiff(ctx(d));
    expect(before.files).toEqual([]);
    writeFileSync(join(d, 'a.txt'), 'one\n');
    execFileSync('git', ['-C', d, 'add', '.']);
    const staged = await workspaceDiff(ctx(d));
    expect(staged.files).toEqual(['a.txt']);
    expect(staged.hash).not.toBe(before.hash);
  });

  it('hashes every change against HEAD, untracked files included, without touching the index', async () => {
    const d = dir();
    writeFileSync(join(d, 'a.txt'), 'one\n');
    execFileSync('git', ['-C', d, 'add', '.']);
    execFileSync('git', [
      '-C',
      d,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-qm',
      'x',
    ]);
    const clean = await workspaceDiff(ctx(d));
    expect(clean.files).toEqual([]);
    writeFileSync(join(d, 'a.txt'), 'two\n');
    const edited = await workspaceDiff(ctx(d));
    expect(edited.files).toEqual(['a.txt']);
    expect(edited.diff).toMatch(/-one\n\+two/);
    expect(edited.hash).not.toBe(clean.hash);
    expect((await workspaceDiff(ctx(d))).hash).toBe(edited.hash);
    writeFileSync(join(d, 'new.txt'), 'x');
    const added = await workspaceDiff(ctx(d));
    expect(added.files).toEqual(['a.txt', 'new.txt']);
    // A new file is shown as an addition; a binary one only by name.
    expect(added.diff).toMatch(/\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+x/);
    expect(added.diff).not.toMatch(/untracked files:/);
    writeFileSync(join(d, 'blob.bin'), Buffer.from([1, 0, 2]));
    expect((await workspaceDiff(ctx(d))).diff).toMatch(/untracked files:\n {2}blob\.bin/);
    rmSync(join(d, 'blob.bin'));
    expect(added.hash).not.toBe(edited.hash);
    writeFileSync(join(d, 'new.txt'), 'y');
    expect((await workspaceDiff(ctx(d))).hash).not.toBe(added.hash);
    expect(execFileSync('git', ['-C', d, 'diff', '--cached', '--name-only']).toString()).toBe('');
    // Regression: the run's own checkpoint file counted as an edit and changed the hash every save.
    mkdirSync(join(d, '.symphony', 'runs'), { recursive: true });
    writeFileSync(join(d, '.symphony', 'runs', 'r.json'), '{"n":1}');
    const withRun = await workspaceDiff(ctx(d));
    expect(withRun.files).toEqual(['a.txt', 'new.txt']);
    writeFileSync(join(d, '.symphony', 'runs', 'r.json'), '{"n":2}');
    expect((await workspaceDiff(ctx(d))).hash).toBe(withRun.hash);
    // Only some paths: changes elsewhere leave their hash alone.
    const onlyNew = await tool('git.diff').run({ paths: ['new.txt'] }, ctx(d));
    expect(onlyNew.files).toEqual(['new.txt']);
    writeFileSync(join(d, 'a.txt'), 'three\n');
    expect((await workspaceDiff(ctx(d), ['new.txt'])).hash).toBe(onlyNew.hash);
    writeFileSync(join(d, 'new.txt'), 'z');
    expect((await workspaceDiff(ctx(d), ['new.txt'])).hash).not.toBe(onlyNew.hash);
    expect((await workspaceDiff(ctx(d), ['gone.txt'])).files).toEqual([]);
  });
});

describe('evidence.check', () => {
  it('splits findings into the ones the workspace backs up and the rest, with why', async () => {
    const d = dir();
    writeFileSync(join(d, 'a.js'), 'export const port = 8081;\n');
    const out = await tool('evidence.check').run(
      {
        findings: [
          'a.js:1 — exports the port `port = 8081`',
          'a.js:1 — the port is `port = 8080`',
          'web | https://example.com — a page',
        ],
      },
      ctx(d),
    );
    expect(out).toEqual({
      valid: ['a.js:1 — exports the port `port = 8081`', 'web | https://example.com — a page'],
      invalid: ['a.js:1 — the port is `port = 8080` ✗ the quote `port = 8080` is not at a.js:1'],
      checked: 2,
    });
  });
});

/** One file's section of a git diff, with `lines` added lines. */
const fileDiff = (name: string, lines: number) =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${'+x\n'.repeat(lines)}`;

describe('truncateDiff', () => {
  it('names the files a long diff cut off, partly or entirely', () => {
    const file = fileDiff;
    const diff = file('a.ts', 5) + file('b.ts', 40) + file('c.ts', 5) + file('d.ts', 5);
    const out = truncateDiff(diff, 100);
    expect(out.startsWith(diff.slice(0, 100))).toBe(true);
    expect(out).toMatch(
      /… diff truncated at 100 characters; partly shown: b\.ts; not shown: c\.ts, d\.ts …$/,
    );
  });
});

describe('git.pr', () => {
  it('reports the PR the runtime checked out, why it could not, or nothing', async () => {
    const run = (pr?: unknown) =>
      tool('git.pr').run({}, { ...ctx(root), ...(pr ? { pr } : {}) } as never);
    expect(await run()).toEqual({ number: 0, base: '', files: [], paths: [], error: '' });
    expect(
      await run({ number: 7, base: 'abc', head: 'def', files: ['M\ta.js', 'A\tsrc/b c.js'] }),
    ).toEqual({
      number: 7,
      base: 'abc',
      files: ['M\ta.js', 'A\tsrc/b c.js'],
      paths: ['a.js', 'src/b c.js'],
      error: '',
    });
    expect(await run({ number: 8, error: 'could not fetch' })).toEqual({
      number: 8,
      base: '',
      files: [],
      paths: [],
      error: 'could not fetch',
    });
  });
});

const commitAll = (d: string) =>
  execFileSync('git', [
    '-C',
    d,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-qam',
    'x',
  ]);

describe('diff.scan', { timeout: 30_000 }, () => {
  it('scans a range, or the uncommitted changes, and refuses anything that is not a range', async () => {
    const d = dir();
    writeFileSync(join(d, 'a.js'), 'export const a = 1;\n');
    execFileSync('git', ['-C', d, 'add', '.']);
    commitAll(d);
    writeFileSync(join(d, 'a.js'), 'export const a = 1;\nconsole.log(a);\n');
    const working = await tool('diff.scan').run({ range: '' }, ctx(d));
    expect(working.smells).toEqual(['a.js:2 — debug output left in (G12)']);
    commitAll(d);
    const ranged = await tool('diff.scan').run({ range: 'HEAD~1..HEAD' }, ctx(d));
    expect(ranged).toMatchObject({ error: '', smells: ['a.js:2 — debug output left in (G12)'] });
    expect(ranged.diff).toMatch(/\+console\.log\(a\);/);
    const option = await tool('diff.scan').run({ range: '--output=/tmp/x' }, ctx(d));
    expect(option).toMatchObject({
      diff: '',
      error: 'not a git revision or range: --output=/tmp/x',
    });
    const unknown = await tool('diff.scan').run({ range: 'nope..HEAD' }, ctx(d));
    expect(unknown.error).not.toBe('');
  });

  it('briefs each lens asked for, with the branches found inside the changed test bodies', async () => {
    const d = dir();
    writeFileSync(join(d, 'a.js'), 'export const a = 1;\n');
    execFileSync('git', ['-C', d, 'add', '.']);
    commitAll(d);
    writeFileSync(
      join(d, 'a.test.js'),
      "it('reads a', () => {\n  if (a) expect(a).toBe(1);\n});\n",
    );
    const out = await tool('pillars.scan').run(
      { range: '', pillars: ['TESTS', 'SECURITY'] },
      ctx(d),
    );
    const lenses = out.lenses as string[];
    expect(lenses.map((l) => l.split(' ')[0])).toEqual(['SECURITY', 'TESTS']);
    expect(out.testBreaks).toEqual(["a.test.js:2 — an if inside the test 'reads a' (UT-3.2)"]);
    expect(lenses[1]).toContain("- a.test.js:2 — an if inside the test 'reads a' (UT-3.2)");
  });
});
