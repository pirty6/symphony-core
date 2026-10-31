/**
 * Workspace tools for patterns that change code: the engine runs the tests
 * and reads the diff itself, so "tests passed" and "nothing changed" are
 * facts, not an AI's report. Commands come from the run inputs or the
 * project's own test script, never from the AI.
 */
import { checkCitations } from './evidence.js';
import { recall, rememberFacts, rememberLesson } from './memory.js';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ToolContext, ToolSpec } from './tools.js';
import { preloadFiles } from './preload.js';

const git = promisify(execFile);

/** Default time a test or lint command may run. */
export const TEST_TIMEOUT_MS = 10 * 60_000;
const MAX_LINES = 120;
const NPM_NO_TEST = /no test specified/;

/**
 * Make command output stable across runs and machines, so identical results
 * hash identically: no colours, durations, timestamps, temp or workspace paths.
 * Long output keeps its head and tail, where failures and summaries are.
 */
export function normalizeOutput(text: string, workspace = ''): string {
  // oxlint-disable-next-line no-control-regex -- ANSI colour codes are what is being removed
  let s = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');
  if (workspace) s = s.split(workspace).join('.');
  s = s
    .replace(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g,
      '<timestamp>',
    )
    .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, '<time>')
    .replace(/(\/private)?\/var\/folders\/[^\s:'")]+|\/tmp\/[^\s:'")]+/g, '<tmp>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min)\b/g, '<duration>')
    // The unit in the label instead: node --test's "duration_ms 90.7", "elapsed: 1.2".
    .replace(/\b(duration|elapsed|took|time)(_\w+)?([:=]?\s+)\d+(\.\d+)?\b/gi, '$1$2$3<duration>')
    .replace(/[ \t]+$/gm, '');
  const lines = s.trim().split('\n');
  if (lines.length <= MAX_LINES) return lines.join('\n');
  const half = MAX_LINES / 2;
  return [
    ...lines.slice(0, half),
    `… ${lines.length - MAX_LINES} lines omitted …`,
    ...lines.slice(-half),
  ].join('\n');
}

/** The project's own test command: its package.json test script, or a language default. */
export async function detectTestCommand(workspace: string): Promise<string | undefined> {
  const has = (f: string) => existsSync(join(workspace, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const test = pkg.scripts?.test;
      if (test && !NPM_NO_TEST.test(test)) {
        if (has('pnpm-lock.yaml')) return 'pnpm test';
        if (has('yarn.lock')) return 'yarn test';
        if (has('bun.lockb') || has('bun.lock')) return 'bun run test';
        return 'npm test';
      }
    } catch {
      // unreadable package.json: try the other defaults
    }
  }
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) return 'python -m pytest';
  return undefined;
}

export type CommandResult = {
  readonly passed: boolean;
  readonly output: string;
  readonly command: string;
};

const MAX_OUTPUT = 32 * 1024 * 1024;

/** Stop a command and everything it started (a test runner's workers too). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Run a command in the workspace. A non-zero exit or a timeout is a result, not an
 * error. On timeout or stop the whole process tree is killed: killing only the
 * shell would leave the test processes running (and holding the workspace).
 */
export function runCommand(
  command: string,
  ctx: ToolContext,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const child = spawn(command, {
      cwd: ctx.workspace,
      shell: true,
      // Its own process group, so a timeout can kill the group (POSIX).
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let out = '';
    const take = (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString('utf8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => killTree(child.pid);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const done = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (ctx.signal.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      const output = normalizeOutput(out, ctx.workspace);
      if (!timedOut && !error && code === 0) {
        resolve({ passed: true, output, command });
        return;
      }
      const why = timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : error
          ? `could not run: ${error.message}`
          : `exit code ${String(code ?? '?')}`;
      resolve({ passed: false, output: `${why}\n${output}`.trim(), command });
    };
    child.on('error', (e) => done(null, e));
    child.on('close', (code) => done(code));
  });
}

export type WorkspaceDiff = {
  readonly diff: string;
  /** Hash of every change against HEAD, including untracked files. Equal hash, equal workspace. */
  readonly hash: string;
  readonly files: readonly string[];
};

/** A lesson is a lead, not a report: plain text, without this run's finding ids or headings. */
function plain(s: unknown): string {
  return String(s ?? '')
    .replace(/\[(?:F\d+[,\s]*)+\]/g, '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Baseline test results by workspace state; a few dozen at most. */
const REUSED = new Map<string, Readonly<Record<string, unknown>>>();
function remember(key: string, result: Readonly<Record<string, unknown>>): void {
  REUSED.set(key, result);
  if (REUSED.size > 50) REUSED.delete(REUSED.keys().next().value!);
}

/** The command plus everything that could change its result: HEAD and the working changes. */
async function workspaceKey(ctx: ToolContext, command: string): Promise<string | undefined> {
  try {
    // No commits yet: no HEAD, and the working changes are everything.
    const head = await git('git', ['rev-parse', '--verify', '-q', 'HEAD'], {
      cwd: ctx.workspace,
    }).then(
      (r) => r.stdout.trim(),
      () => '',
    );
    const { hash } = await workspaceDiff(ctx);
    return `${ctx.workspace}\0${command}\0${head}\0${hash}`;
  } catch {
    return undefined;
  }
}

/** git's id for the empty tree. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF = 30_000;

/** Cut a long diff, naming every file whose changes were cut off (nothing dropped silently). */
export function truncateDiff(diff: string, max: number): string {
  const headers = [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => ({
    file: m[1]!,
    at: m.index,
  }));
  const partly = headers.filter((h, i) => h.at < max && (headers[i + 1]?.at ?? diff.length) > max);
  const omitted = headers.filter((h) => h.at >= max);
  const said = [
    ...(partly.length ? [`partly shown: ${partly.map((h) => h.file).join(', ')}`] : []),
    ...(omitted.length ? [`not shown: ${omitted.map((h) => h.file).join(', ')}`] : []),
  ];
  return `${diff.slice(0, max)}\n… diff truncated at ${max} characters${said.length ? `; ${said.join('; ')}` : ''} …`;
}
/** Symphony's own files (saved runs, checkpoints) are never the edit. */
const NOT_THE_EDIT = ':(exclude).symphony';

/**
 * Changes in the workspace against HEAD, or only in `paths` when given (e.g. to
 * check that tests written first were left alone). Read-only: never touches the index.
 */
export async function workspaceDiff(
  ctx: ToolContext,
  paths: readonly string[] = [],
): Promise<WorkspaceDiff> {
  const where = paths.length > 0 ? paths : ['.'];
  const run = async (args: string[]) =>
    (
      await git('git', args, {
        cwd: ctx.workspace,
        maxBuffer: 64 * 1024 * 1024,
        signal: ctx.signal,
      })
    ).stdout;
  // A repository without commits yet has no HEAD: compare with the empty tree.
  const base = await run(['rev-parse', '--verify', '-q', 'HEAD']).then(
    () => 'HEAD',
    () => EMPTY_TREE,
  );
  const diff = await run([
    '--no-pager',
    'diff',
    base,
    '--no-color',
    '--no-ext-diff',
    '--',
    ...where,
    NOT_THE_EDIT,
  ]);
  const changed = (await run(['diff', base, '--name-only', '--', ...where, NOT_THE_EDIT]))
    .split('\n')
    .filter(Boolean);
  const untracked = (
    await run(['ls-files', '--others', '--exclude-standard', '--', ...where, NOT_THE_EDIT])
  )
    .split('\n')
    .filter(Boolean);
  const h = createHash('sha256').update(diff);
  for (const f of untracked.toSorted()) {
    h.update(`\0${f}\0`);
    try {
      h.update(await readFile(join(ctx.workspace, f)));
    } catch {
      // vanished or unreadable: its name still counts
    }
  }
  const files = [...new Set([...changed, ...untracked])].toSorted();
  const shown = diff.length > MAX_DIFF ? truncateDiff(diff, MAX_DIFF) : diff;
  const extra = untracked.length
    ? `\nuntracked files:\n${untracked.map((f) => `  ${f}`).join('\n')}`
    : '';
  return { diff: `${shown}${extra}`.trim(), hash: h.digest('hex').slice(0, 16), files };
}

export function workspaceTools(): ToolSpec[] {
  return [
    {
      name: 'tests.run',
      description:
        "Run a test, lint or typecheck command in the workspace (the given `command`, or the project's test script). Failure is a result: { passed, output, command }.",
      outputs: ['passed', 'output', 'command'],
      run: async (args, ctx) => {
        const given = typeof args.command === 'string' ? args.command.trim() : '';
        const command = given || (await detectTestCommand(ctx.workspace));
        if (!command) {
          throw new Error(
            'no test command: set the testCommand input (e.g. "npm test"), or add a test script to package.json',
          );
        }
        const timeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : TEST_TIMEOUT_MS;
        if (args.reuse !== true) return runCommand(command, ctx, timeout);
        // A baseline: the same command on the very same workspace gives the same answer.
        const key = await workspaceKey(ctx, command);
        const known = key ? REUSED.get(key) : undefined;
        if (known)
          return {
            ...known,
            output: `${String(known.output)}\n(reused: the workspace is unchanged since this command last ran)`,
          };
        const result = await runCommand(command, ctx, timeout);
        if (key) remember(key, result);
        return result;
      },
    },
    {
      name: 'files.read',
      description:
        'Read workspace files whole, with line numbers, for a prompt (a step that preloads its files): { files: [{ path, text, lines, omitted? }] }.',
      outputs: ['files'],
      run: async (args, ctx) => ({
        files: await preloadFiles(ctx.workspace, Array.isArray(args.paths) ? args.paths : []),
      }),
    },
    {
      name: 'git.diff',
      description:
        'The workspace changes against HEAD (untracked files included), or only in `paths`: { diff, hash, files }. Equal hash means nothing changed.',
      outputs: ['diff', 'hash', 'files'],
      run: (args, ctx) =>
        workspaceDiff(
          ctx,
          Array.isArray(args.paths)
            ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
            : [],
        ),
    },
    {
      name: 'evidence.check',
      description:
        'Check cited findings against the workspace: a "path:line — fact `quote`" must name a real file and line, and the quote must be there. { valid, invalid } (invalid entries end with why).',
      outputs: ['valid', 'invalid', 'checked'],
      run: async (args, ctx) => {
        const findings = Array.isArray(args.findings)
          ? args.findings.filter((f): f is string => typeof f === 'string')
          : [];
        const r = await checkCitations(ctx.workspace, findings);
        // What held is remembered for later runs (re-checked whenever it is recalled), unless
        // the pattern remembers only what its answer used (remember: false, then memory.facts).
        if (args.remember !== false)
          await rememberFacts(ctx.memoryRoot ?? ctx.workspace, r.valid, undefined, ctx.runId).catch(
            () => 0,
          );
        return {
          valid: r.valid,
          invalid: r.invalid.map((i) => `${i.finding} ✗ ${i.reason}`),
          // How many cited a workspace file and were checked: 0 is not "all valid".
          checked: r.checked,
        };
      },
    },
    {
      name: 'memory.facts',
      description:
        'Remember checked findings for later runs (only quoted path:line ones; re-checked when recalled): { findings } → { saved }.',
      outputs: ['saved'],
      run: async (args, ctx) => ({
        saved: await rememberFacts(
          ctx.memoryRoot ?? ctx.workspace,
          Array.isArray(args.findings)
            ? args.findings.filter((f): f is string => typeof f === 'string')
            : [],
          undefined,
          ctx.runId,
        ).catch(() => 0),
      }),
    },
    {
      name: 'memory.recall',
      description:
        'Facts from earlier runs that still hold in the workspace (re-checked now) and lessons from earlier runs, ranked by the words they share with `query`: { facts, lessons }.',
      outputs: ['facts', 'lessons'],
      run: (args, ctx) =>
        recall(ctx.workspace, String(args.query ?? ''), 12, {
          ...(ctx.memoryRoot ? { store: ctx.memoryRoot } : {}),
          ...(ctx.runId ? { excludeRun: ctx.runId } : {}),
        }),
    },
    {
      name: 'memory.lesson',
      description:
        'Remember how a run ended: { kind: "fixed" | "failed" | "implemented" | "answered" | …, problem, cause, files, failure }. Returns { saved }.',
      outputs: ['saved'],
      run: async (args, ctx) => {
        // Paths, or cited findings ("F3 src/a.ts:12 — …"): a lesson's files tell when it is stale.
        const files = [
          ...new Set(
            (Array.isArray(args.files) ? args.files : []).flatMap((f) => {
              const m = /^(?:F\d+\s+)?([\w@./-]+\.[A-Za-z0-9]+)(?::\d|\s|$)/.exec(String(f).trim());
              return m ? [m[1]!] : [];
            }),
          ),
        ].slice(0, 12);
        const kind = String(args.kind ?? 'fixed');
        const problem = String(args.problem ?? '').slice(0, 300);
        const cause = plain(args.cause).slice(0, 500);
        const open = (Array.isArray(args.open) ? args.open : []).slice(0, 3).map(plain);
        const doubtful = args.outcome === 'partial';
        const text =
          kind === 'failed'
            ? `FAILED to fix "${problem}": ${plain(args.failure ?? 'unknown').slice(0, 500)}`
            : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}${doubtful ? ' (with open doubts)' : ''} "${problem}": ${cause}${open.length ? ` Open: ${open.join('; ')}` : ''}${files.length ? ` (files: ${files.join(', ')})` : ''}`;
        return {
          saved: await rememberLesson(ctx.memoryRoot ?? ctx.workspace, text, files, undefined, {
            workspace: ctx.workspace,
            ...(ctx.runId ? { run: ctx.runId } : {}),
          }),
        };
      },
    },
  ];
}
