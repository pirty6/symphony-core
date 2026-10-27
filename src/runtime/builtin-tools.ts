/**
 * Built-in tools for `tool` nodes.
 *
 *   repo.files       every file in the workspace (git-aware), plus what was excluded and why
 *   sources.catalog  every evidence source available to agents right now
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { discoverMcpServers, type McpOptions } from './mcp.js';
import { listRuns } from './store.js';
import { registry, type ToolContext, type ToolRegistry, type ToolSpec } from './tools.js';

const exec = promisify(execFile);

const BINARY = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'tiff',
  'psd',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'jar',
  'war',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'ogg',
  'webm',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'class',
  'o',
  'a',
  'wasm',
  'pyc',
  'db',
  'sqlite',
  'node',
]);
const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
]);
const WALK_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.symphony',
  '.next',
  'coverage',
]);
export const DEFAULT_MAX_BYTES = 512 * 1024;

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await exec(cmd, args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 15_000,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!WALK_SKIP.has(entry.name)) await walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) out.push(relative(root, join(dir, entry.name)));
  }
  return out;
}

export async function listRepoFiles(
  workspace: string,
  opts: { maxBytes?: number; includeLockfiles?: boolean; signal?: AbortSignal } = {},
): Promise<{ files: string[]; excluded: string[] }> {
  let all: string[];
  try {
    const out = await run(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      workspace,
      opts.signal,
    );
    all = out.split('\0').filter(Boolean);
  } catch {
    all = await walk(workspace);
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const files: string[] = [];
  const excluded: string[] = [];
  for (const file of [...new Set(all)].toSorted()) {
    const name = file.split('/').at(-1) ?? file;
    const ext = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
    if (BINARY.has(ext)) {
      excluded.push(`${file} — binary file`);
      continue;
    }
    if (!opts.includeLockfiles && LOCKFILES.has(name)) {
      excluded.push(`${file} — dependency lockfile`);
      continue;
    }
    let size: number;
    try {
      size = (await stat(join(workspace, file))).size;
    } catch {
      excluded.push(`${file} — deleted or unreadable`);
      continue;
    }
    if (size > maxBytes) {
      excluded.push(
        `${file} — larger than ${Math.round(maxBytes / 1024)} KB (${Math.round(size / 1024)} KB)`,
      );
      continue;
    }
    files.push(file);
  }
  return { files, excluded };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface CatalogOptions {
  readonly mcp?: Omit<McpOptions, 'workspace'>;
  /** Skip probing GitHub (`gh`), e.g. in tests. */
  readonly probeGitHub?: boolean;
}

export async function sourceCatalog(
  ctx: ToolContext,
  opts: CatalogOptions = {},
): Promise<{ names: string[]; descriptions: string[] }> {
  const entries: [string, string][] = [];
  const ws = ctx.workspace;
  try {
    const count = (await run('git', ['rev-list', '--count', 'HEAD'], ws, ctx.signal)).trim();
    entries.push([
      'git-history',
      `${count} commits: why code changed (git log -p, git blame, git show)`,
    ]);
  } catch {
    // not a git repo
  }
  if (opts.probeGitHub !== false) {
    try {
      const repo = (
        await run(
          'gh',
          ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
          ws,
          ctx.signal,
        )
      ).trim();
      if (repo) {
        entries.push([
          'github',
          `issues, pull requests, reviews and CI runs of ${repo} (read-only gh issue/pr/run/search/api commands)`,
        ]);
      }
    } catch {
      // gh missing, not signed in, or no GitHub remote
    }
  }
  const manifests = [
    ['package.json', 'node_modules/<pkg> sources, types and README files'],
    ['requirements.txt', 'installed Python packages (pip show, site-packages)'],
    ['pyproject.toml', 'installed Python packages (pip show, site-packages)'],
    ['go.mod', 'Go module sources (go doc, module cache)'],
    ['Cargo.toml', 'crate sources (cargo doc, registry)'],
  ] as const;
  for (const [file, how] of manifests) {
    if (await exists(join(ws, file))) {
      entries.push(['dependencies', `third-party code and docs this project uses: ${how}`]);
      break;
    }
  }
  entries.push([
    'web',
    'the public internet: web_search(query) to find pages, web_fetch(url) to read them',
  ]);
  const mcp = await discoverMcpServers({ ...opts.mcp, workspace: ws });
  for (const name of Object.keys(mcp.servers).toSorted()) {
    entries.push([`mcp:${name}`, `MCP server '${name}' (read-only tools only)`]);
  }
  const runs = await listRuns(join(ctx.repoRoot, '.symphony', 'runs'));
  if (runs.length > 0) {
    entries.push([
      'prior-runs',
      `${runs.length} earlier Symphony runs with recorded answers in ${join(ctx.repoRoot, '.symphony', 'runs')}`,
    ]);
  }
  return { names: entries.map(([n]) => n), descriptions: entries.map(([n, d]) => `${n}: ${d}`) };
}

export function builtinTools(opts: CatalogOptions = {}): ToolSpec[] {
  return [
    {
      name: 'repo.files',
      description: 'Every file in the workspace (git-aware), with exclusions listed and explained.',
      outputs: ['files', 'excluded'],
      run: (args, ctx) =>
        listRepoFiles(ctx.workspace, {
          ...(typeof args.maxBytes === 'number' ? { maxBytes: args.maxBytes } : {}),
          includeLockfiles: args.includeLockfiles === true,
          signal: ctx.signal,
        }),
    },
    {
      name: 'sources.catalog',
      description:
        'Every evidence source available to agents: git history, GitHub, dependencies, web, MCP servers, prior runs.',
      outputs: ['names', 'descriptions'],
      run: (_args, ctx) => sourceCatalog(ctx, opts),
    },
  ];
}

export function defaultTools(opts: CatalogOptions = {}): ToolRegistry {
  return registry(builtinTools(opts));
}
