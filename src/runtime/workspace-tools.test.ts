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
const tool = (name: string) => workspaceTools().find((t) => t.name === name)!;

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
    expect(
      await tool('tests.run').run({ command: 'node -e "process.exit(0)"' }, ctx(d)),
    ).toMatchObject({
      passed: true,
    });
  });
});

describe('git.diff', () => {
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
          'a.js:1 — the port is `8080`',
          'web | https://example.com — a page',
        ],
      },
      ctx(d),
    );
    expect(out).toEqual({
      valid: ['a.js:1 — exports the port `port = 8081`', 'web | https://example.com — a page'],
      invalid: ['a.js:1 — the port is `8080` ✗ the quote `8080` is not at a.js:1'],
    });
  });
});

describe('memory tools', () => {
  it('what one run verified, the next run recalls; lessons too', async () => {
    const d = dir();
    writeFileSync(join(d, 'config.js'), 'export const port = DEFAULTS.port + 1;\n');
    await tool('evidence.check').run(
      { findings: ['config.js:1 — the default port is one above DEFAULTS `DEFAULTS.port + 1`'] },
      ctx(d),
    );
    await tool('memory.lesson').run(
      { kind: 'fixed', problem: 'wrong default port', cause: 'off by one', files: ['config.js'] },
      ctx(d),
    );
    const r = (await tool('memory.recall').run({ query: 'what is the default port?' }, ctx(d))) as {
      facts: string[];
      lessons: string[];
    };
    expect(r.facts).toEqual([
      'config.js:1 — the default port is one above DEFAULTS `DEFAULTS.port + 1`',
    ]);
    expect(r.lessons[0]).toMatch(/Fixed "wrong default port": off by one \(files: config.js\)$/);
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
