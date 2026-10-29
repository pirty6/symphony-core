/**
 * Built-in tools for `tool` nodes.
 *
 *   repo.files       every file in the workspace (git-aware), plus what was excluded and why
 *   sources.catalog  every evidence source available to agents right now
 */
import { DEMO_ONLY } from '../core/catalog.js';
import { workspaceTools } from './workspace-tools.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { adaptPattern, outlinePattern, parseDraft } from '../core/draft.js';
import type { Pattern } from '../core/types.js';
import { PATTERNS, routeMatches } from '../patterns/index.js';
import { discoverMcpServers, type McpOptions } from './mcp.js';
import { recallCompositions, rememberComposition } from './memory.js';
import { DRAFTS_DIR, listRuns, savePatternFile } from './store.js';
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
    } else if (entry.isFile()) {
      // Same '/' paths as git ls-files, whatever the platform.
      out.push(relative(root, join(dir, entry.name)).replaceAll('\\', '/'));
    }
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
  /** Pattern library for maestro tools; defaults to the built-in patterns. */
  readonly library?: () => Promise<readonly Pattern[]>;
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
  const inventory = await listRepoFiles(ws, { signal: ctx.signal }).catch(() => undefined);
  if (inventory && inventory.files.length > 0) {
    entries.push([
      'workspace',
      `${inventory.files.length} files in this workspace: every one is triaged and the relevant ones read completely`,
    ]);
  }
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
  entries.push([
    'experiment',
    'run commands in the workspace to reproduce behaviour or measure performance (benchmarks, timing, profiling); needs your approval; scratch files only',
  ]);
  const mcp = await discoverMcpServers({ ...opts.mcp, workspace: ws });
  for (const name of Object.keys(mcp.servers).toSorted()) {
    entries.push([`mcp:${name}`, `MCP server '${name}' (read-only tools only)`]);
  }
  const runs = await listRuns(join(ctx.repoRoot, '.symphony', 'runs'));
  if (runs.length > 0) {
    entries.push([
      'prior-runs',
      // No count: a run's own history must not change the next run's input.
      `earlier Symphony runs with recorded answers in ${join(ctx.repoRoot, '.symphony', 'runs')}`,
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
    ...workspaceTools(),
    ...maestroTools(opts.library ?? (async () => PATTERNS)),
  ];
}

export function defaultTools(opts: CatalogOptions = {}): ToolRegistry {
  return registry(builtinTools(opts));
}

const stripDemo = ({ demo: _demo, ...data }: Pattern) => data;

/** The inputs a pattern needs, one line each: what reading them from a request takes. */
export const inputsOf = (p: Pattern): string[] =>
  p.requiredContext.map((name) => {
    const f = p.state.find((x) => x.name === name);
    return `${name} (${f?.type ?? 'string'})${f?.description ? `: ${f.description}` : ''}`;
  });

/** A library pattern's fingerprint: a remembered adaptation is reused only on the same pattern. */
export const patternFingerprint = (p: Pattern): string =>
  createHash('sha256')
    .update(JSON.stringify(stripDemo(p)))
    .digest('hex')
    .slice(0, 16);

const asObject = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

const isFilled = (x: unknown): boolean =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length > 0;

/**
 * An empty draft with a library template: the template as adapted (the maestro
 * tailors tested patterns instead of rewriting them). A filled draft wins: the
 * shape had to change. Undefined when there is no template to adapt.
 */
function fromTemplate(
  draft: unknown,
  template: unknown,
  adaptation: unknown,
): { pattern: Pattern } | { errors: string[] } | undefined {
  if (isFilled(draft) || !isFilled(template)) return undefined;
  const base = parseDraft(template);
  if (!base.ok) return { errors: base.errors.map((e) => `template: ${e}`) };
  const out = adaptPattern(base.value, adaptation ?? {});
  return out.errors.length > 0 ? { errors: out.errors } : { pattern: out.pattern };
}

/** Tools the maestro uses: list the library, route by verb triggers, validate and save a drafted score. */
export function maestroTools(library: () => Promise<readonly Pattern[]>): ToolSpec[] {
  // Neither the maestro itself nor a demo game is a route for real work.
  const lib = async () =>
    (await library()).filter((p) => p.name !== 'maestro' && !DEMO_ONLY.has(p.name));
  return [
    {
      name: 'patterns.list',
      description: 'Every pattern in the library: names, one-line summaries and full definitions.',
      outputs: ['names', 'summaries', 'catalog'],
      run: async () => {
        const all = await lib();
        return {
          names: all.map((p) => p.name),
          summaries: all.map(
            (p) =>
              `${p.name}: ${p.description}${p.requiredContext.length ? ` (needs: ${p.requiredContext.join(', ')})` : ''}${p.verbTriggers?.length ? ` [triggers: ${p.verbTriggers.join(', ')}]` : ''}`,
          ),
          catalog: Object.fromEntries(all.map((p) => [p.name, stripDemo(p)])),
        };
      },
    },
    {
      name: 'patterns.route',
      description:
        "Deterministic routing: the pattern whose verb triggers best match the request, or 'new'.",
      outputs: ['suggested', 'matches'],
      run: async (args) => {
        const matches = routeMatches(String(args.request ?? ''), await lib()).map((p) => p.name);
        return { suggested: matches[0] ?? 'new', matches };
      },
    },
    {
      name: 'pattern.validate',
      description:
        'Validate a drafted pattern; returns the normalized pattern or the problems. With an empty draft, a library `template` and an `adaptation`, validates the template as adapted.',
      outputs: ['errors', 'valid', 'pattern', 'inputs'],
      run: async (args) => {
        const adapted = fromTemplate(args.pattern, args.template, args.adaptation);
        if (adapted && 'errors' in adapted)
          return { errors: adapted.errors, valid: false, pattern: {}, inputs: [] };
        const parsed = parseDraft(adapted ? adapted.pattern : args.pattern);
        return parsed.ok
          ? {
              errors: [],
              valid: true,
              pattern: stripDemo(parsed.value),
              inputs: inputsOf(parsed.value),
            }
          : { errors: parsed.errors, valid: false, pattern: {}, inputs: [] };
      },
    },
    {
      name: 'compositions.recall',
      description:
        'Approved maestro compositions in this workspace: `exact` is one for the same request on an unchanged pattern, to reuse without a debate ({} if none); `similar` are the closest others, as precedent.',
      outputs: ['exact', 'similar'],
      run: async (args, ctx) => {
        const all = await lib();
        const fingerprint = (name: string) => {
          const p = all.find((x) => x.name === name);
          return p ? patternFingerprint(p) : undefined;
        };
        const r = await recallCompositions(ctx.workspace, String(args.request ?? ''), fingerprint);
        return { exact: r.exact ?? {}, similar: r.similar };
      },
    },
    {
      name: 'compositions.remember',
      description:
        'Remember an approved composition (request, chosen pattern, complexity, then-pattern, and its adaptation or full pattern). Returns { saved }.',
      outputs: ['saved'],
      run: async (args, ctx) => {
        const chosen = String(args.chosen ?? '');
        const known = (await lib()).find((p) => p.name === chosen);
        // A drafted (new or reshaped) score is remembered whole; an adapted one by its adaptation.
        const whole = chosen === 'new' || isFilled(args.draft);
        await rememberComposition(ctx.workspace, {
          request: String(args.request ?? ''),
          chosen,
          complexity: typeof args.complexity === 'number' ? args.complexity : 2,
          thenPattern: typeof args.thenPattern === 'string' ? args.thenPattern : '',
          adaptation: whole ? {} : asObject(args.adaptation),
          pattern: whole ? asObject(args.pattern) : {},
          template: known ? patternFingerprint(known) : '',
        });
        return { saved: true };
      },
    },
    {
      name: 'pattern.outline',
      description:
        'A compact view of a pattern for prompts: its steps (AI steps with the start of their directive) and the settings an adaptation may change: { steps, settings }.',
      outputs: ['steps', 'settings'],
      run: async (args) => {
        const parsed = isFilled(args.pattern) ? parseDraft(args.pattern) : undefined;
        return parsed?.ok ? outlinePattern(parsed.value) : { steps: [], settings: [] };
      },
    },
    {
      name: 'pattern.save',
      description: `Save a pattern as ${DRAFTS_DIR}/<name>.ts in symphony-core, so the studio and the CLI list it. Validates it again; refuses the names of built-in patterns.`,
      outputs: ['file', 'name'],
      run: async (args, ctx) => {
        const parsed = parseDraft(args.pattern);
        if (!parsed.ok) throw new Error(`not a valid pattern: ${parsed.errors.join('; ')}`);
        const p = stripDemo(parsed.value);
        if (p.name === 'maestro' || PATTERNS.some((b) => b.name === p.name))
          throw new Error(`'${p.name}' is a built-in pattern: pick another name`);
        const file = await savePatternFile(
          join(ctx.repoRoot, DRAFTS_DIR),
          p,
          '../../core/types.js',
        );
        return { file: relative(ctx.repoRoot, file), name: p.name };
      },
    },
  ];
}
