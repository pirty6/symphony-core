import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultTools, listRepoFiles, sourceCatalog } from './builtin-tools.js';
import { compileScore } from '../core/compile.js';
import { toPerformance } from '../core/engine.js';
import { runScripted } from '../core/scripted.js';
import { fix } from '../patterns/index.js';
import { saveRun } from './store.js';
import { discoverMcpServers, stripJsonc, userMcpFiles } from './mcp.js';

const root = mkdtempSync(join(tmpdir(), 'symphony-tools-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  writeFileSync(join(dir, 'logo.png'), 'x');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lock');
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(2048));
  writeFileSync(join(dir, '.gitignore'), 'ignored.ts\n');
  writeFileSync(join(dir, 'ignored.ts'), 'secret');
  writeFileSync(join(dir, 'package.json'), '{}');
  return dir;
}

const prior = (c: { descriptions: readonly string[] }) =>
  c.descriptions.find((d) => d.startsWith('prior-runs:'));

const ctx = (workspace: string) => ({
  workspace,
  repoRoot: workspace,
  signal: new AbortController().signal,
});

describe('repo.files', () => {
  it('lists every file, explaining each exclusion', async () => {
    const dir = repo('r1');
    const r = await listRepoFiles(dir, { maxBytes: 1024 });
    expect(r.files).toEqual(['.gitignore', 'README.md', 'package.json', 'src/a.ts']);
    expect(r.excluded).toEqual([
      'big.txt — larger than 1 KB (2 KB)',
      'logo.png — binary file',
      'pnpm-lock.yaml — dependency lockfile',
    ]);
    expect(r.files).not.toContain('ignored.ts');
  });

  it('walks folders when git is unavailable', async () => {
    const dir = join(root, 'plain');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '');
    writeFileSync(join(dir, 'main.py'), 'print(1)');
    expect((await listRepoFiles(dir)).files).toEqual(['main.py']);
  });
});

describe('sources.catalog', () => {
  it('describes available sources', async () => {
    const dir = repo('r2');
    execFileSync('git', [
      '-C',
      dir,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    ]);
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(
      join(dir, '.vscode', 'mcp.json'),
      '{ "servers": { "docs": { "type": "http", "url": "https://x" } } }',
    );
    const c = await sourceCatalog(ctx(dir), { probeGitHub: false, mcp: { includeUser: false } });
    expect(c.names).toEqual([
      'workspace',
      'git-history',
      'dependencies',
      'web',
      'experiment',
      'mcp:docs',
    ]);
    expect(c.descriptions[0]).toMatch(/^workspace: 6 files/);
    expect(c.descriptions[1]).toMatch(/^git-history: 1 commits/);

    // A run's own history must not change the next run's input.
    const runs = join(dir, '.symphony', 'runs');
    const score = compileScore(fix, { context: fix.demo!.context!, generatedAt: 't' });
    const performance = toPerformance(runScripted(score, fix.demo, { at: 't' }).state);
    await saveRun(runs, { schemaVersion: 3, score, performance });
    const once = await sourceCatalog(ctx(dir), { probeGitHub: false, mcp: { includeUser: false } });
    await saveRun(runs, {
      schemaVersion: 3,
      score,
      performance: { ...performance, startedAt: 'u' },
    });
    const twice = await sourceCatalog(ctx(dir), {
      probeGitHub: false,
      mcp: { includeUser: false },
    });
    expect(prior(once)).toMatch(/^prior-runs: earlier Symphony runs/);
    expect(prior(twice)).toBe(prior(once));
  });

  it('is exposed through the default registry', async () => {
    const tools = defaultTools({ probeGitHub: false, mcp: { includeUser: false } });
    expect([...tools.keys()]).toEqual([
      'repo.files',
      'sources.catalog',
      'tests.run',
      'git.diff',
      'evidence.check',
      'memory.recall',
      'memory.lesson',
      'patterns.list',
      'patterns.route',
      'pattern.validate',
      'pattern.outline',
      'pattern.save',
    ]);
    const out = await tools.get('repo.files')!.run({}, ctx(repo('r3')));
    expect(out.files).toContain('src/a.ts');
  });
});

describe('MCP discovery', () => {
  it('strips JSONC without touching strings', () => {
    expect(
      JSON.parse(stripJsonc('{ "url": "https://a//b", /* c */ "x": [1,2,], // tail\n }')),
    ).toEqual({ url: 'https://a//b', x: [1, 2] });
  });

  it('merges user and workspace servers, substitutes variables, skips unusable ones', async () => {
    const home = join(root, 'home');
    const ws = join(root, 'ws');
    const userFile = userMcpFiles(home, 'linux', {})[0]!;
    mkdirSync(join(userFile, '..'), { recursive: true });
    writeFileSync(
      userFile,
      `{ // user servers
        "servers": {
          "teams": { "type": "stdio", "command": "agency", "args": ["mcp", "teams"] },
          "symphony": { "type": "stdio", "command": "node", "args": ["mcp-server.js"] },
          "shared": { "command": "old" },
          "secret": { "command": "x", "env": { "TOKEN": "\${input:token}" } },
        },
      }`,
    );
    mkdirSync(join(ws, '.vscode'), { recursive: true });
    writeFileSync(
      join(ws, '.vscode', 'mcp.json'),
      '{ "servers": { "shared": { "command": "new", "args": ["${workspaceFolder}/x"], "env": { "K": "${env:MY_KEY}" } } } }',
    );
    writeFileSync(
      join(ws, '.mcp.json'),
      '{ "mcpServers": { "remote": { "url": "https://mcp.example/sse", "type": "sse" }, "off": { "command": "z", "disabled": true } } }',
    );
    const d = await discoverMcpServers({
      workspace: ws,
      home,
      platform: 'linux',
      env: { MY_KEY: 'k1' },
    });
    expect(Object.keys(d.servers).toSorted()).toEqual(['remote', 'shared', 'teams']);
    expect(d.servers.teams).toEqual({
      type: 'stdio',
      command: 'agency',
      args: ['mcp', 'teams'],
      tools: ['*'],
    });
    expect(d.servers.shared).toEqual({
      type: 'stdio',
      command: 'new',
      args: [`${ws}/x`],
      env: { K: 'k1' },
      tools: ['*'],
    });
    expect(d.servers.remote).toEqual({ type: 'sse', url: 'https://mcp.example/sse', tools: ['*'] });
    expect(d.skipped).toEqual(["secret: needs the VS Code input 'token'", 'off: disabled']);
    const noUser = await discoverMcpServers({
      workspace: ws,
      home,
      platform: 'linux',
      env: {},
      includeUser: false,
    });
    expect(Object.keys(noUser.servers)).toEqual(['remote']);
    expect(noUser.skipped[0]).toMatch(/environment variable MY_KEY is not set/);
  });
});

describe('maestro tools', () => {
  const tools = defaultTools({ probeGitHub: false, mcp: { includeUser: false } });
  const c = ctx('.');

  it('lists the library without demo scripts and routes by verb triggers', async () => {
    const list = await tools.get('patterns.list')!.run({}, c);
    expect(list.names).toEqual(expect.arrayContaining(['investigate', 'fix', 'review', 'hangman']));
    expect(list.names).not.toContain('maestro');
    expect(JSON.stringify(list.catalog)).not.toContain('demo');
    expect((list.summaries as string[]).find((x) => x.startsWith('fix:'))).toMatch(/needs: issue/);
    expect(
      await tools.get('patterns.route')!.run({ request: 'please fix the broken login' }, c),
    ).toMatchObject({ suggested: 'fix' });
    expect(await tools.get('patterns.route')!.run({ request: 'compose a haiku' }, c)).toEqual({
      suggested: 'new',
      matches: [],
    });
  });

  it('validates drafted scores', async () => {
    const bad = await tools.get('pattern.validate')!.run({ pattern: { name: 'x' } }, c);
    expect(bad).toMatchObject({ valid: false, pattern: {} });
    expect((bad.errors as string[]).length).toBeGreaterThan(0);
    const list = await tools.get('patterns.list')!.run({}, c);
    const good = await tools
      .get('pattern.validate')!
      .run({ pattern: (list.catalog as Record<string, unknown>).fix }, c);
    expect(good).toMatchObject({ valid: true, errors: [] });
  });

  it('validates a library template as adapted; a filled draft wins', async () => {
    const list = await tools.get('patterns.list')!.run({}, c);
    const fix = (list.catalog as Record<string, Record<string, unknown>>).fix!;
    const validate = tools.get('pattern.validate')!;
    const adapted = await validate.run(
      {
        pattern: {},
        template: fix,
        adaptation: {
          directives: { hypothesize: 'Start from PR 1.' },
          initial: { maxAttempts: 1 },
        },
      },
      c,
    );
    expect(adapted).toMatchObject({ valid: true, errors: [] });
    const p = adapted.pattern as {
      nodes: { id: string; directive?: string }[];
      state: { name: string; initial?: unknown }[];
    };
    expect(p.nodes.find((n) => n.id === 'hypothesize')!.directive).toMatch(
      /For this request: Start from PR 1\.$/,
    );
    expect(p.state.find((f) => f.name === 'maxAttempts')!.initial).toBe(1);
    const wrong = await validate.run(
      { pattern: {}, template: fix, adaptation: { directives: { nope: 'x' } } },
      c,
    );
    expect(wrong).toMatchObject({
      valid: false,
      errors: [expect.stringMatching(/no step 'nope'/)],
    });
    const review = (list.catalog as Record<string, Record<string, unknown>>).review!;
    expect(
      await validate.run(
        { pattern: review, template: fix, adaptation: { directives: { nope: 'x' } } },
        c,
      ),
    ).toMatchObject({
      valid: true,
      pattern: { name: 'review' },
    });
    const outline = await tools.get('pattern.outline')!.run({ pattern: fix }, c);
    expect((outline.steps as string[]).length).toBeGreaterThan(5);
    expect(JSON.stringify(outline).length).toBeLessThan(JSON.stringify(fix).length / 3);
    expect(await tools.get('pattern.outline')!.run({ pattern: {} }, c)).toEqual({
      steps: [],
      settings: [],
    });
  });

  it('saves a pattern where the studio lists drafts, never over a built-in one', async () => {
    const repoRoot = join(root, 'save');
    const list = await tools.get('patterns.list')!.run({}, c);
    const review = (list.catalog as Record<string, Record<string, unknown>>).review!;
    const save = tools.get('pattern.save')!;
    const out = await save.run({ pattern: { ...review, name: 'storm-review' } }, ctx(repoRoot));
    expect(out).toEqual({
      file: join('src', 'patterns', 'drafts', 'storm-review.ts'),
      name: 'storm-review',
    });
    expect(readFileSync(join(repoRoot, out.file as string), 'utf8')).toMatch(
      /name: 'storm-review'/,
    );
    await expect(save.run({ pattern: review }, ctx(repoRoot))).rejects.toThrow(/built-in pattern/);
    await expect(save.run({ pattern: { name: 'x' } }, ctx(repoRoot))).rejects.toThrow(
      /not a valid pattern/,
    );
  });
});
