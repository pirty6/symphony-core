/**
 * Workspace tools for patterns that change code: the engine runs the tests
 * and reads the diff itself, so "tests passed" and "nothing changed" are
 * facts, not an AI's report. Commands come from the run inputs or the
 * project's own test script, never from the AI.
 */
import { checkCitations } from './evidence.js';
import { recall, rememberFacts, rememberLesson } from './memory.js';
import { exec as execCb, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ToolContext, ToolSpec } from './tools.js';

const exec = promisify(execCb);
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

/** Run a command in the workspace. A non-zero exit or a timeout is a result, not an error. */
export async function runCommand(
  command: string,
  ctx: ToolContext,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd: ctx.workspace,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      signal: ctx.signal,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return {
      passed: true,
      output: normalizeOutput(`${stdout}\n${stderr}`, ctx.workspace),
      command,
    };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const err = e as { stdout?: string; stderr?: string; killed?: boolean; code?: number | string };
    const why = err.killed
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : `exit code ${String(err.code ?? '?')}`;
    const output = normalizeOutput(`${err.stdout ?? ''}\n${err.stderr ?? ''}`, ctx.workspace);
    return { passed: false, output: `${why}\n${output}`.trim(), command };
  }
}

export type WorkspaceDiff = {
  readonly diff: string;
  /** Hash of every change against HEAD, including untracked files. Equal hash, equal workspace. */
  readonly hash: string;
  readonly files: readonly string[];
};

const MAX_DIFF = 30_000;
/** Symphony's own files (saved runs, checkpoints) are never the edit. */
const NOT_THE_EDIT = ':(exclude).symphony';

/** Changes in the workspace against HEAD. Read-only: never touches the index. */
export async function workspaceDiff(ctx: ToolContext): Promise<WorkspaceDiff> {
  const run = async (args: string[]) =>
    (
      await git('git', args, {
        cwd: ctx.workspace,
        maxBuffer: 64 * 1024 * 1024,
        signal: ctx.signal,
      })
    ).stdout;
  const diff = await run([
    '--no-pager',
    'diff',
    'HEAD',
    '--no-color',
    '--no-ext-diff',
    '--',
    '.',
    NOT_THE_EDIT,
  ]);
  const changed = (await run(['diff', 'HEAD', '--name-only', '--', '.', NOT_THE_EDIT]))
    .split('\n')
    .filter(Boolean);
  const untracked = (
    await run(['ls-files', '--others', '--exclude-standard', '--', '.', NOT_THE_EDIT])
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
  const shown = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… diff truncated …` : diff;
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
        return runCommand(command, ctx, timeout);
      },
    },
    {
      name: 'git.diff',
      description:
        'The workspace changes against HEAD (untracked files included): { diff, hash, files }. Equal hash means nothing changed.',
      outputs: ['diff', 'hash', 'files'],
      run: (_args, ctx) => workspaceDiff(ctx),
    },
    {
      name: 'evidence.check',
      description:
        'Check cited findings against the workspace: a "path:line — fact `quote`" must name a real file and line, and the quote must be there. { valid, invalid } (invalid entries end with why).',
      outputs: ['valid', 'invalid'],
      run: async (args, ctx) => {
        const findings = Array.isArray(args.findings)
          ? args.findings.filter((f): f is string => typeof f === 'string')
          : [];
        const r = await checkCitations(ctx.workspace, findings);
        // What held is remembered for later runs (re-checked whenever it is recalled).
        await rememberFacts(ctx.workspace, r.valid).catch(() => 0);
        return { valid: r.valid, invalid: r.invalid.map((i) => `${i.finding} ✗ ${i.reason}`) };
      },
    },
    {
      name: 'memory.recall',
      description:
        'Facts from earlier runs that still hold in the workspace (re-checked now) and lessons from earlier fix/implement runs, ranked by the words they share with `query`: { facts, lessons }.',
      outputs: ['facts', 'lessons'],
      run: (args, ctx) => recall(ctx.workspace, String(args.query ?? '')),
    },
    {
      name: 'memory.lesson',
      description:
        'Remember how a fix or implement run ended: { kind: "fixed" | "failed" | "implemented", problem, cause, files, failure }. Returns { saved }.',
      outputs: ['saved'],
      run: async (args, ctx) => {
        const files = Array.isArray(args.files) ? args.files.map(String) : [];
        const text =
          args.kind === 'failed'
            ? `FAILED to fix "${String(args.problem ?? '')}": ${String(args.failure ?? 'unknown')}`
            : `${args.kind === 'implemented' ? 'Implemented' : 'Fixed'} "${String(args.problem ?? '')}": ${String(args.cause ?? '')} (files: ${files.join(', ')})`;
        await rememberLesson(ctx.workspace, text, files);
        return { saved: true };
      },
    },
  ];
}
