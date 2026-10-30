#!/usr/bin/env node
/**
 * symphony CLI. Run with `npm run cli -- <command>` (no build needed).
 *
 *   list                                   pattern library
 *   show <pattern>                         nodes and edges
 *   run <pattern> [options]                run a pattern in the terminal
 *   draft "<request>" [--save]             let the AI draft a new pattern
 *   verify <run.json>                      integrity + deterministic replay check
 *   compare <a.json> <b.json>              first divergence between two runs and its cause
 *   rehearse <pattern> -n N                play a score N times; which nodes agree
 *   resume <run.json> | fork <run.json> --at N   continue from a checkpoint
 *   runs                                   saved runs
 */
import { type Adaptation, summarizeComposed } from './core/draft.js';
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compileScore, CompileError } from './core/compile.js';
import { formatReport, runEval, summarize, worseThan, type EvalReport } from './eval/harness.js';
import { EVAL_TASKS, ROUTING_TASKS } from './eval/tasks.js';
import { type ChainStep, followUps, playsAfter, stepContext, stepPattern } from './core/chain.js';
import { formatUsage, performanceUsage, rejectionUsage } from './core/usage.js';
import { describeEdits } from './core/edits.js';
import { agreement, compareRuns } from './core/compare.js';
import { engineNote, RUN_SCHEMA_VERSION } from './core/migrate.js';
import { replayPerformance, restoreEngine } from './core/replay.js';
import { parseFieldInput } from './core/schema.js';
import type {
  Complexity,
  ExecutableScore,
  FieldType,
  Improvisation,
  Pattern,
  Performance,
  SavedRun,
} from './core/types.js';
import { libraryPatterns, maestro, maestroThen } from './patterns/index.js';
import { concertNext } from './runtime/concert.js';
import { loadRepertoire, runsDirFor } from './runtime/store.js';
import { editsFiles, isolate } from './runtime/worktree.js';
import { IMPROVISATION_LEVELS, isImprovisation, playsFromRepertoire } from './core/jazz.js';
import { Run, type NextPerformance, type RunMessage, type RunOptions } from './runtime/driver.js';
import { draftPattern } from './runtime/drafting.js';
import {
  envConfig,
  isProviderName,
  makeProvider,
  runtimeExtras,
  type ProviderName,
} from './runtime/factory.js';
import {
  autoPrune,
  gitFingerprint,
  pruneRuns,
  runScratch,
  listRuns,
  loadPatternFiles,
  loadRun,
  savePatternFile,
  saveRun,
} from './runtime/store.js';

export const RUNS_DIR = '.symphony/runs';
export const DRAFTS_DIR = 'src/patterns/drafts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

/** Parse `key=value` pairs, coercing by the pattern's field types. */
export function parseContext(pairs: readonly string[], pattern: Pattern): Record<string, unknown> {
  const types = new Map<string, FieldType>(pattern.state.map((f) => [f.name, f.type]));
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`context must be key=value, got '${pair}'`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    const type = types.get(key);
    if (!type) throw new Error(`'${key}' is not a state field of '${pattern.name}'`);
    out[key] = parseFieldInput(type, raw);
  }
  return out;
}

async function allPatterns(cwd: string): Promise<Pattern[]> {
  const drafts = await loadPatternFiles(
    join(cwd, DRAFTS_DIR),
    (f) => import(pathToFileURL(f).href),
  );
  return libraryPatterns(process.env, drafts);
}

function printMessage(m: RunMessage, write: (s: string) => void): void {
  if (m.type === 'provider') {
    const e = m.event;
    if (e.type === 'delta') write(c.dim(e.text));
    else if (e.type === 'tool-start') write(`\n    ${c.cyan(`⚙ ${e.name}`)}\n`);
    else if (e.type === 'permission' && !e.allowed) write(`\n    ${c.red(`⛔ ${e.detail}`)}\n`);
    else if (e.type === 'info') write(`\n    ${c.dim(e.text)}\n`);
    return;
  }
  if (m.type === 'status') {
    if (m.status === 'paused') write(`\n${c.yellow(`⏸  paused ${m.phase} '${m.nodeId}'`)}\n`);
    return;
  }
  if (m.type === 'performance') return;
  if (m.type === 'next') {
    write(
      m.error
        ? `\n${c.yellow(`⚠ ${m.error}`)}\n`
        : `\n${c.green(`♪ composed '${m.pattern.name}'`)} ${c.dim(`inputs ${JSON.stringify(m.context)}`)}\n`,
    );
    return;
  }
  const e = m.event;
  switch (e.type) {
    case 'node-entered':
      write(`\n${c.bold(`[${e.step}] ${e.nodeId}`)} ${c.dim(e.kind)}\n`);
      break;
    case 'guard-evaluated':
      write(`    ${c.dim(`${e.expression} → ${e.result}`)}\n`);
      break;
    case 'edge-taken':
      write(
        `    ${c.dim(`→ ${e.to}`)}${e.carried.length ? c.dim(`  carries ${JSON.stringify(e.values)}`) : ''}\n`,
      );
      break;
    case 'node-completed':
      for (const ch of e.changes)
        write(
          `    ${c.green('Δ')} ${ch.key}: ${JSON.stringify(ch.before)} → ${JSON.stringify(ch.after)}\n`,
        );
      if (e.verdict)
        write(
          `    ${c.dim(`verdict ${e.verdict.outcome} (${e.verdict.confidence}) ${e.verdict.reason}`)}\n`,
        );
      break;
    case 'response-rejected':
      write(`\n    ${c.red(`✗ response rejected: ${e.errors.join('; ')}`)}\n`);
      break;
    case 'run-completed':
      write(`\n${c.green(`✔ ${e.outcome}`)} ${c.dim(e.reason)}\n`);
      break;
    case 'run-failed':
      write(`\n${c.red(`✘ failed: ${e.error}`)}\n`);
      break;
    default:
      break;
  }
}

interface PlayOptions {
  readonly providerName: ProviderName;
  readonly model?: string;
  readonly autoApprove: boolean;
  readonly step: boolean;
  readonly breakpoints: readonly string[];
  readonly save: boolean;
  readonly rl?: ReturnType<typeof createInterface>;
  readonly next?: (perf: Performance) => Promise<NextPerformance | undefined>;
  /** Print only the header and the saved file. */
  readonly quiet?: boolean;
  /** Never replay recorded answers (rehearsals measure the musicians). */
  readonly fresh?: boolean;
  /** Continue a restored run (resume / fork). */
  readonly restore?: RunOptions['restore'];
}

/**
 * What to do with an approval when nobody is at a terminal and --auto-approve was not given.
 * The offline demo's answers are canned and edit nothing; a real AI's would let it act
 * (e.g. edit files) without anyone deciding, so the run stops instead.
 */
export function unattendedApproval(provider: ProviderName): 'demo-answer' | 'stop' {
  return provider === 'scripted' ? 'demo-answer' : 'stop';
}

function describeGate(state: Readonly<Record<string, unknown>>): string {
  const p = state.normalized as Pattern | undefined;
  if (!p?.nodes) return '';
  const summary = summarizeComposed(state);
  const fresh = summary?.kind === 'new' || summary?.kind === 'rewritten';
  const lines = [
    `  ${c.bold(`score '${p.name}'`)} · complexity ${String(state.complexity)} · round ${String(state.round)}`,
    ...(summary ? [`  ${summary.headline}`] : []),
    // A tested library pattern's steps are known; list them only for a new or rewritten one.
    ...(fresh || !summary
      ? [`  ${p.nodes.map((n) => n.id).join(' → ')}`]
      : summary.guided.length
        ? [c.dim(`  guidance on: ${summary.guided.join(', ')}`)]
        : []),
    ...((state.debateNotes as string[] | undefined) ?? []).map((n) => c.dim(`  ${n}`)),
    c.dim(`  inputs ${JSON.stringify(state.childContext ?? {})}`),
  ];
  return lines.join('\n');
}

async function play(
  score: ExecutableScore,
  pattern: Pattern,
  cwd: string,
  o: PlayOptions,
): Promise<Performance> {
  const extras = await runtimeExtras(cwd, cwd, process.env);
  for (const s of extras.mcpSkipped) console.log(c.dim(`MCP server skipped: ${s}`));
  const runsDir = runsDirFor(cwd);
  // A composed score has no demo script; reuse the library's when it is a known pattern.
  const demo = pattern.demo ?? (await allPatterns(cwd)).find((p) => p.name === pattern.name)?.demo;
  // A real AI editing files plays in its own worktree; its edits come back when it ends.
  const isolation =
    o.providerName === 'copilot' && editsFiles(score)
      ? await isolate(cwd, score.pattern)
      : undefined;
  const dir = isolation?.dir ?? cwd;
  if (isolation) console.log(c.dim(`playing in its own worktree: ${dir}`));
  const run = new Run({
    score,
    tools: extras.tools,
    toolContext: isolation ? { ...extras.toolContext, workspace: dir } : extras.toolContext,
    provider: makeProvider({
      provider: o.providerName,
      pattern: demo ? { ...pattern, demo } : pattern,
      workingDirectory: dir,
      mcpServers: extras.mcpServers,
      ...envConfig(process.env),
      ...(o.model ? { model: o.model } : {}),
    }),
    ...(demo ? { demo } : {}),
    ...(playsFromRepertoire(score.improvisation) && !o.fresh
      ? { repertoire: await loadRepertoire(runsDir) }
      : {}),
    autoApprove: o.autoApprove,
    stepMode: o.step,
    breakpoints: o.breakpoints,
    ...(o.providerName === 'copilot'
      ? { envHash: () => gitFingerprint(dir), scratch: await runScratch(cwd) }
      : {}),
    ...(isolation ? { isolation } : {}),
    ...(o.save ? { onSave: (r) => saveRun(runsDir, r), checkpoint: true } : {}),
    ...(o.restore ? { restore: o.restore } : {}),
    ...(o.next ? { next: o.next } : {}),
  });
  const level = IMPROVISATION_LEVELS[score.improvisation]!;
  console.log(
    `${c.bold(pattern.name)} ${c.dim(`score ${score.id.slice(0, 12)} · provider ${o.providerName} · complexity ${score.complexity} · ${level.icon} ${level.name}`)}`,
  );
  const rl = o.rl;
  run.subscribe(async (m) => {
    if (!o.quiet) printMessage(m, (s) => process.stdout.write(s));
    if (m.type === 'status' && m.status === 'paused') {
      if (!rl) return run.resume();
      await rl.question(c.yellow('  enter = continue '));
      run.resume();
    }
    if (m.type === 'status' && m.status === 'awaiting-approval') {
      const pause = run.engine.pause;
      if (pause?.kind === 'stuck') {
        if (!rl) {
          run.answerRecovery({ action: 'stop', by: 'cli' });
          return;
        }
        console.log(
          `\n  ${c.yellow('⚠')} '${pause.label}' gave no valid answer in ${pause.attempts} attempts (tier ${pause.complexity}):`,
        );
        for (const f of pause.feedback) console.log(c.red(`    ${f}`));
        if (/^n/i.test(await rl.question('  retry this step? [Y/n] '))) {
          run.answerRecovery({ action: 'stop', by: 'cli' });
          return;
        }
        const hint = await rl.question('  hint for the AI (enter to skip): ');
        const tier = (
          await rl.question(`  complexity tier 1-4 (enter for ${pause.complexity}): `)
        ).trim();
        const n = Number(tier);
        const complexity = n === 1 || n === 2 || n === 3 || n === 4 ? n : undefined;
        run.answerRecovery({
          action: 'retry',
          ...(hint.trim() ? { hint } : {}),
          ...(complexity && complexity !== pause.complexity ? { complexity } : {}),
          by: 'cli',
        });
        return;
      }
      if (!rl && unattendedApproval(o.providerName) === 'stop') {
        run.stop(
          `'${pause?.nodeId ?? '?'}' needs your approval but there is no terminal: run it in a terminal, or pass --auto-approve`,
        );
        return;
      }
      if (!rl || pause?.kind !== 'approval') {
        run.answerApproval({ approved: true, scripted: true });
        return;
      }
      console.log(`\n  ${c.yellow('✋')} ${pause.message}`);
      if (pause.nodeId === 'gate') console.log(describeGate(run.engine.state));
      if (pause.feedback?.length) console.log(c.red(`  ${pause.feedback.join('; ')}`));
      const updates: Record<string, unknown> = {};
      for (const f of pause.outputSchema) {
        updates[f.name] = parseFieldInput(f.type, await rl.question(`  ${f.name} (${f.type}): `));
      }
      const ok = !/^n/i.test(await rl.question('  approve? [Y/n] '));
      run.answerApproval({ approved: ok, updates, by: 'cli' });
    }
  });
  const stop = () => run.stop('interrupted');
  process.on('SIGINT', stop);
  const perf = await run.start();
  process.off('SIGINT', stop);
  const saved = run.messages.find((m) => m.type === 'performance');
  if (saved?.type === 'performance' && saved.savedTo) console.log(c.dim(`saved ${saved.savedTo}`));
  if (!o.quiet) console.log(c.dim(`final state ${JSON.stringify(perf.finalState).slice(0, 2000)}`));
  const used = performanceUsage(perf).total;
  if (used.calls > 0) console.log(c.dim(`tokens: ${formatUsage(used)}`));
  const rejected = rejectionUsage(perf);
  if (rejected.attempts > 0 || rejected.textUpdates > 0) {
    const text = rejected.textUpdates
      ? ` · ${rejected.textUpdates} answers sent updates as text`
      : '';
    console.log(
      c.dim(
        `rejected: ${rejected.attempts} attempts (${formatUsage(rejected.attemptUsage)})${text}`,
      ),
    );
  }
  if (perf.edits) console.log(describeEdits(perf.edits));
  return perf;
}

function levelOf(raw: string | undefined): Improvisation | undefined {
  if (raw === undefined) return undefined;
  const byName = IMPROVISATION_LEVELS.find((l) => l.name.toLowerCase() === raw.toLowerCase());
  const n = byName ? byName.level : Number(raw);
  if (!isImprovisation(n))
    throw new Error('--improvisation must be 0-4 or classical|cool|swing|bebop|free');
  return n;
}

function complexityOf(raw: string | undefined): Complexity | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (n !== 1 && n !== 2 && n !== 3 && n !== 4)
    throw new Error('--complexity must be 1, 2, 3 or 4');
  return n;
}

const RUN_OPTIONS = {
  provider: { type: 'string', default: 'scripted' },
  model: { type: 'string' },
  complexity: { type: 'string' },
  improvisation: { type: 'string', short: 'i' },
  'auto-approve': { type: 'boolean', default: false },
  break: { type: 'string', multiple: true },
  step: { type: 'boolean', default: false },
  'no-save': { type: 'boolean', default: false },
} as const;

const SCORE_OPTIONS = {
  ...RUN_OPTIONS,
  goal: { type: 'string' },
  context: { type: 'string', short: 'c', multiple: true },
  // oxlint-disable-next-line unicorn/no-thenable -- the --then flag; parseArgs config, never awaited
  then: { type: 'string', multiple: true },
} as const;

/** `-c key=value` pairs for this pattern, and `-c next.key=value` pairs for chained ones. */
function splitContext(
  pairs: readonly string[] | undefined,
  then: readonly string[],
): { own: string[]; chained: Map<string, string[]> } {
  const own: string[] = [];
  const chained = new Map<string, string[]>();
  for (const pair of pairs ?? []) {
    const dot = pair.indexOf('.');
    const name = dot > 0 ? pair.slice(0, dot) : '';
    if (then.includes(name) && dot < pair.indexOf('=')) {
      chained.set(name, [...(chained.get(name) ?? []), pair.slice(dot + 1)]);
    } else own.push(pair);
  }
  return { own, chained };
}

const thenList = (raw: readonly string[] | undefined) =>
  (raw ?? [])
    .flatMap((t) => t.split(','))
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Play a score, then each chained pattern while runs succeed: the next one's
 * goal input gets what the previous run delivered (core handoffContext). A
 * backlog run adds one run per picked item; items go on after a failed item.
 * Exit code 2 when any run failed.
 */
async function playChain(
  first: { score: ExecutableScore; pattern: Pattern },
  then: readonly ChainStep[],
  cwd: string,
  o: PlayOptions,
  chained: ReadonlyMap<string, string[]> = new Map(),
): Promise<number> {
  let current = first;
  let perf = await play(current.score, current.pattern, cwd, o);
  let failed = perf.outcome === 'failed';
  const queue: ChainStep[] = [...then];
  const items: { goal: string; outcome: string }[] = [];
  for (;;) {
    queue.unshift(...followUps(current.score, perf));
    const step = queue.shift();
    if (!step || !playsAfter(step, perf.outcome)) break;
    const name = stepPattern(step);
    const pattern = (await allPatterns(cwd)).find((p) => p.name === name);
    if (!pattern) throw new Error(`--then: unknown pattern '${name}'`);
    const given = parseContext(chained.get(name) ?? [], pattern);
    const prev = { score: current.score, performance: perf };
    const { goal, context } = stepContext(pattern, step, prev, given);
    const score = compileScore(pattern, {
      goal,
      context,
      complexity: current.score.complexity,
      improvisation: current.score.improvisation,
    });
    const left = queue.filter((s) => typeof s !== 'string').length;
    console.log(
      typeof step === 'string'
        ? `\n${c.bold(`♪ then ${name}`)} ${c.dim(`with what ${current.pattern.name} found`)}`
        : `\n${c.bold(`♪ ${name}: ${goal}`)} ${c.dim(`(${left} more queued)`)}`,
    );
    current = { score, pattern };
    perf = await play(score, pattern, cwd, o);
    failed ||= perf.outcome === 'failed';
    if (typeof step !== 'string') items.push({ goal, outcome: perf.outcome });
  }
  if (items.length > 0) {
    console.log(`\n${c.bold('♪ backlog')}`);
    for (const i of items) {
      const mark = i.outcome === 'success' ? c.green('✓') : c.red('✗');
      console.log(`  ${mark} ${i.outcome.padEnd(9)} ${i.goal}`);
    }
  }
  return failed ? 2 : 0;
}

type ScoreArgs = ReturnType<
  typeof parseArgs<{ options: typeof SCORE_OPTIONS; allowPositionals: true }>
>;

/** Pattern + compiled score from `run`-style arguments, or an exit code. */
async function scoreFromArgs(
  { values, positionals }: Pick<ScoreArgs, 'values' | 'positionals'>,
  cwd: string,
): Promise<{ pattern: Pattern; score: ExecutableScore; provider: ProviderName } | number> {
  const name = positionals[0];
  const pattern = (await allPatterns(cwd)).find((p) => p.name === name);
  if (!pattern) {
    console.error(`unknown pattern '${name ?? ''}'. Try: symphony list`);
    return 1;
  }
  if (!isProviderName(values.provider)) {
    console.error(`--provider must be scripted or copilot`);
    return 1;
  }
  const { own } = splitContext(values.context, thenList(values.then));
  const context = own.length > 0 ? parseContext(own, pattern) : (pattern.demo?.context ?? {});
  const complexity = complexityOf(values.complexity);
  const improvisation = levelOf(values.improvisation);
  let score;
  try {
    score = compileScore(pattern, {
      goal: values.goal ?? pattern.demo?.goal ?? pattern.description,
      context,
      ...(complexity ? { complexity } : {}),
      ...(improvisation !== undefined ? { improvisation } : {}),
    });
  } catch (e) {
    if (e instanceof CompileError) {
      console.error(c.red(e.message));
      return 1;
    }
    throw e;
  }
  return { pattern, score, provider: values.provider };
}

async function cmdRun(argv: string[], cwd: string): Promise<number> {
  const args = parseArgs({ args: argv, allowPositionals: true, options: SCORE_OPTIONS });
  const values = args.values;
  const built = await scoreFromArgs(args, cwd);
  if (typeof built === 'number') return built;
  const { pattern, score, provider } = built;
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  try {
    const then = thenList(values.then);
    return await playChain(
      { score, pattern },
      then,
      cwd,
      {
        providerName: provider,
        ...(values.model ? { model: values.model } : {}),
        autoApprove: values['auto-approve'],
        step: values.step,
        breakpoints: values.break ?? [],
        save: !values['no-save'],
        ...(rl ? { rl } : {}),
      },
      splitContext(values.context, then).chained,
    );
  } finally {
    rl?.close();
  }
}

async function cmdEval(argv: string[], cwd: string): Promise<number> {
  const args = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string', default: 'copilot' },
      model: { type: 'string' },
      task: { type: 'string' },
      repeat: { type: 'string', short: 'n', default: '1' },
      compare: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const providerName = args.values.provider;
  if (!isProviderName(providerName)) {
    console.error('--provider must be scripted or copilot');
    return 1;
  }
  const wanted = args.values.task?.split(',').map((t) => t.trim());
  // `routing` names every maestro routing task; they are not in the default run.
  const every = [...EVAL_TASKS, ...ROUTING_TASKS];
  const tasks = wanted
    ? every.filter(
        (t) => wanted.includes(t.id) || (wanted.includes('routing') && ROUTING_TASKS.includes(t)),
      )
    : EVAL_TASKS;
  if (tasks.length === 0) {
    console.error(`no such task; tasks: routing, ${every.map((t) => t.id).join(', ')}`);
    return 1;
  }
  const baseline = args.values.compare
    ? (JSON.parse(await readFile(args.values.compare, 'utf8')) as EvalReport)
    : undefined;
  const library = await allPatterns(cwd);
  console.log(c.dim(`eval: ${tasks.length} task(s) × ${args.values.repeat} on ${providerName}`));
  const report = await runEval({
    tasks,
    library,
    providerName,
    repoRoot: cwd,
    env: process.env,
    repeat: Number(args.values.repeat),
    keep: args.values.keep,
    runsDir: join(
      cwd,
      '.symphony',
      'evals',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-runs`,
    ),
    provider: (workspace, pattern) =>
      makeProvider({
        provider: providerName,
        pattern,
        workingDirectory: workspace,
        ...envConfig(process.env),
        ...(args.values.model ? { model: args.values.model } : {}),
      }),
    onResult: (r) =>
      console.log(c.dim(`  ${r.pass ? '✔' : '✘'} ${r.task} ${(r.ms / 1000).toFixed(0)}s`)),
  });
  const dir = join(cwd, '.symphony', 'evals');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${report.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${formatReport(report, baseline)}\n${c.dim(`saved ${file}`)}`);
  return baseline && worseThan(summarize(report.results), summarize(baseline.results)) ? 2 : 0;
}

async function cmdRehearse(argv: string[], cwd: string): Promise<number> {
  const args = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...SCORE_OPTIONS,
      times: { type: 'string', short: 'n', default: '3' },
      fields: { type: 'string' },
    },
  });
  const times = Number(args.values.times);
  const fields = (args.values.fields ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (!Number.isInteger(times) || times < 2 || times > 20) {
    console.error('--times must be a whole number from 2 to 20');
    return 1;
  }
  const built = await scoreFromArgs(args, cwd);
  if (typeof built === 'number') return built;
  const { pattern, score, provider } = built;
  const runs: SavedRun[] = [];
  for (let i = 1; i <= times; i++) {
    console.log(c.dim(`take ${i} of ${times}`));
    const performance = await play(score, pattern, cwd, {
      providerName: provider,
      ...(args.values.model ? { model: args.values.model } : {}),
      autoApprove: true,
      step: false,
      breakpoints: [],
      save: !args.values['no-save'],
      quiet: true,
      fresh: true,
    });
    runs.push({ schemaVersion: RUN_SCHEMA_VERSION, score, performance });
  }
  const rows = agreement(runs, fields);
  const width = Math.max(4, ...rows.map((r) => r.nodeId.length));
  console.log(
    `\n${c.bold('rehearsal')} ${c.dim(`${times} performances of ${pattern.name} · score ${score.id.slice(0, 12)} · fresh answers (no recorded ones)`)}`,
  );
  console.log(c.dim(`${'node'.padEnd(width)}  ${'kind'.padEnd(9)} reached  variants  agreement`));
  for (const r of rows) {
    const line = `${r.nodeId.padEnd(width)}  ${r.kind.padEnd(9)} ${`${r.reached}/${times}`.padEnd(8)} ${String(r.variants).padEnd(9)} ${Math.round(r.agreement * 100)}%`;
    console.log(r.variants > 1 || r.reached < times ? c.yellow(line) : line);
  }
  const steady = rows.filter((r) => r.variants === 1 && r.reached === times);
  console.log(`\n${steady.length}/${rows.length} nodes played the same notes every time.`);
  for (let i = 1; i < runs.length; i++) {
    const cmp = compareRuns(runs[0]!, runs[i]!);
    if (cmp.first) {
      console.log(
        c.dim(
          `take 1 vs ${i + 1}: first divergence at ${cmp.first.nodeId ?? 'the start'}: ${CAUSE_TEXT[cmp.first.cause]}`,
        ),
      );
    }
  }
  return 0;
}

/** The provider a saved run was played with, from its AI transcripts. */
function recordedProvider(run: SavedRun): ProviderName {
  const live = run.performance.steps.some(
    (s) => s.transcript && s.transcript.provider !== 'scripted' && !s.transcript.fromRepertoire,
  );
  return live ? 'copilot' : 'scripted';
}

async function cmdContinue(
  kind: 'resumed' | 'forked',
  argv: string[],
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      at: { type: 'string' },
      'auto-approve': { type: 'boolean', default: false },
    },
  });
  const file = positionals[0];
  const usage = kind === 'resumed' ? 'resume <run.json>' : 'fork <run.json> --at <step>';
  if (!file || (kind === 'forked' && values.at === undefined)) {
    console.error(
      `usage: symphony ${usage} [--provider scripted|copilot] [--model id] [--auto-approve]`,
    );
    return 1;
  }
  const { run, issues, migrated } = await loadRun(resolve(file));
  for (const m of migrated) console.log(c.dim(`upgraded: ${m}`));
  if (issues.length) {
    console.log(c.red(issues.join('\n')));
    return 2;
  }
  const perf = run.performance;
  if (kind === 'resumed' && perf.outcome !== 'in-progress' && perf.outcome !== 'cancelled') {
    console.error(
      `this run already ended (${perf.outcome}); fork it from a step instead: symphony fork ${file} --at <step>`,
    );
    return 1;
  }
  const at = Number(values.at);
  const last = perf.steps.at(-1)?.step ?? 0;
  if (kind === 'forked' && (!Number.isInteger(at) || at < 1 || at > last + 1)) {
    console.error(`--at must be a step from 1 to ${last + 1}`);
    return 1;
  }
  const throughStep = kind === 'forked' ? at - 1 : last;
  const provider = values.provider ?? recordedProvider(run);
  if (!isProviderName(provider)) {
    console.error('--provider must be scripted or copilot');
    return 1;
  }
  let result;
  try {
    result = restoreEngine(
      run.score,
      perf,
      kind === 'forked' ? { throughStep, startedAt: new Date().toISOString() } : {},
    );
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 2;
  }
  const pattern: Pattern = (await allPatterns(cwd)).find((p) => p.name === run.score.pattern) ?? {
    name: run.score.pattern,
    description: run.score.description,
    requiredContext: [],
    state: run.score.state,
    nodes: run.score.nodes,
    edges: run.score.edges,
    start: run.score.start,
  };
  console.log(
    c.dim(
      `${kind === 'resumed' ? 'resuming' : 'forking'} ${file}: steps 1..${throughStep} replayed from the recording, the rest played live (${provider})`,
    ),
  );
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  try {
    const done = await play(run.score, pattern, cwd, {
      providerName: provider,
      ...(values.model ? { model: values.model } : {}),
      autoApprove: values['auto-approve'],
      step: false,
      breakpoints: [],
      save: true,
      ...(rl ? { rl } : {}),
      restore: { result, basedOn: { kind, from: file, throughStep } },
    });
    return done.outcome === 'failed' ? 2 : 0;
  } finally {
    rl?.close();
  }
}

async function cmdMaestro(argv: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...RUN_OPTIONS,
      'compose-only': { type: 'boolean', default: false },
      save: { type: 'boolean', default: false },
    },
  });
  const request = positionals.join(' ').trim();
  if (!request || !isProviderName(values.provider)) {
    console.error(
      'usage: symphony maestro "<what you want done>" [--provider copilot] [--complexity 1-4] [-i classical|cool|swing|bebop|free]',
    );
    return 1;
  }
  const improvisation = levelOf(values.improvisation);
  // A preset tier wins over the maestro's own rating (cost control), on every surface.
  const complexity = complexityOf(values.complexity);
  const score = compileScore(maestro, {
    goal: 'Compose the score for the request',
    context: { request },
    ...(improvisation !== undefined ? { improvisation } : {}),
    ...(complexity ? { complexity } : {}),
  });
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const o: PlayOptions = {
    providerName: values.provider,
    ...(values.model ? { model: values.model } : {}),
    autoApprove: values['auto-approve'],
    step: values.step,
    breakpoints: values.break ?? [],
    save: !values['no-save'],
    ...(rl ? { rl } : {}),
  };
  let child: { score: ExecutableScore; pattern: Pattern } | undefined;
  let then: string[] = [];
  try {
    const perf = await play(score, maestro, cwd, {
      ...o,
      next: concertNext({
        maestroScore: score,
        start: async (s, p) => {
          child = { score: s, pattern: p };
          return s.id.slice(0, 12);
        },
      }),
    });
    if (perf.outcome !== 'success') return 2;
    if (!child) return 1;
    then = maestroThen(perf.finalState);
    if (values.save) {
      console.log(
        c.dim(
          `saved ${await savePatternFile(join(cwd, DRAFTS_DIR), child.pattern, '../../core/types.js')}`,
        ),
      );
    }
    if (values['compose-only']) {
      console.log(
        `\n${c.bold(`♪ composed '${child.pattern.name}'`)} ${c.dim(`complexity ${child.score.complexity}`)}`,
      );
      const summary = summarizeComposed(perf.finalState);
      if (summary) console.log(`  ${summary.headline}`);
      if (!summary || summary.kind === 'new' || summary.kind === 'rewritten') {
        for (const n of child.pattern.nodes)
          console.log(`  ${n.id.padEnd(14)} ${n.kind.padEnd(10)} ${n.label}`);
      } else {
        // The tested pattern's steps are known (`show <pattern>`); print what changed.
        const a = (perf.finalState.adaptation ?? {}) as Adaptation;
        for (const [id, text] of Object.entries(a.directives ?? {}))
          console.log(`  ${c.bold(id)}: ${text}`);
        for (const [k, x] of Object.entries(a.initial ?? {}))
          console.log(`  ${k} = ${JSON.stringify(x)}`);
      }
      return 0;
    }
    console.log(
      `\n${c.bold('♪ performing the composed score')}${then.length ? c.dim(`, then ${then.join(', ')}`) : ''}`,
    );
    return await playChain(child, then, cwd, o);
  } finally {
    rl?.close();
  }
}

async function cmdDraft(argv: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: 'string', default: 'scripted' },
      model: { type: 'string' },
      save: { type: 'boolean', default: false },
    },
  });
  const request = positionals.join(' ');
  if (!request || !isProviderName(values.provider)) {
    console.error(
      'usage: symphony draft "<what the flow should do>" [--provider copilot] [--save]',
    );
    return 1;
  }
  const provider = makeProvider({
    provider: values.provider,
    workingDirectory: cwd,
    ...envConfig(process.env),
    ...(values.model ? { model: values.model } : {}),
  });
  const out = await draftPattern(provider, request, {
    onEvent: (e) => e.type === 'delta' && process.stdout.write(c.dim(e.text)),
  });
  await provider.dispose?.();
  for (const r of out.rounds)
    if (r.errors.length) console.log(c.red(`\nround ${r.round}: ${r.errors.join('; ')}`));
  if (!out.pattern) return 2;
  console.log(
    `\n${c.green('✔ valid draft')} ${out.pattern.name}: ${out.pattern.nodes.map((n) => n.id).join(' → ')}`,
  );
  if (values.save)
    console.log(
      c.dim(
        `saved ${await savePatternFile(join(cwd, DRAFTS_DIR), out.pattern, '../../core/types.js')}`,
      ),
    );
  return 0;
}

async function cmdVerify(file: string | undefined): Promise<number> {
  if (!file) {
    console.error('usage: symphony verify <run.json>');
    return 1;
  }
  const { run, issues, migrated } = await loadRun(resolve(file));
  for (const m of migrated) console.log(c.dim(`upgraded: ${m}`));
  if (issues.length) {
    console.log(c.red(issues.join('\n')));
    return 2;
  }
  const { divergence } = replayPerformance(run.score, run.performance);
  console.log(
    divergence.reproduced
      ? c.green('✔ reproduced exactly')
      : c.red(`✘ diverged ${JSON.stringify(divergence)}`),
  );
  const engine = divergence.reproduced ? undefined : engineNote(run.performance.engine);
  if (engine) console.log(c.yellow(engine));
  return divergence.reproduced ? 0 : 2;
}

const CAUSE_TEXT = {
  plan: 'the plan: the two scores differ',
  environment: 'the environment: a tool, the workspace or a failure outside the score',
  ai: 'the AI: an agent answered differently',
  human: 'a human: an approval or a stop',
  engine: 'the engine: the same input took a different path (engine code changed)',
} as const;

async function cmdCompare(files: string[]): Promise<number> {
  if (files.length !== 2) {
    console.error('usage: symphony compare <a.json> <b.json>');
    return 1;
  }
  const loaded = await Promise.all(files.map((f) => loadRun(resolve(f))));
  const issues = loaded.flatMap((l, i) => l.issues.map((x) => `${files[i]}: ${x}`));
  if (issues.length) {
    console.log(c.red(issues.join('\n')));
    return 2;
  }
  const cmp = compareRuns(loaded[0]!.run, loaded[1]!.run);
  if (cmp.identical) {
    console.log(c.green('✔ identical performances'));
    return 0;
  }
  if (cmp.first) {
    const where = cmp.first.nodeId ? ` at step ${cmp.first.step} (${cmp.first.nodeId})` : '';
    console.log(`first divergence${where}: ${CAUSE_TEXT[cmp.first.cause]}`);
    console.log(c.dim(`  ${cmp.first.detail}`));
  }
  if (cmp.differentKeys.length)
    console.log(`final state differs in: ${cmp.differentKeys.join(', ')}`);
  if (cmp.models)
    console.log(
      `played by different models: ${cmp.models.first.join(', ') || 'none'} vs ${cmp.models.second.join(', ') || 'none'}`,
    );
  return 3;
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const [cmd, ...rest] = argv;
  // Retention runs by itself at most once a day (SYMPHONY_RETENTION=off disables it).
  if (cmd === 'run' || cmd === 'maestro' || (cmd === 'runs' && !rest.includes('--prune')))
    await autoPrune(cwd, runsDirFor(cwd));
  switch (cmd) {
    case 'list':
      for (const p of await allPatterns(cwd)) {
        console.log(
          `${c.bold(p.name.padEnd(14))} ${p.description}${p.requiredContext.length ? c.dim(`  (needs: ${p.requiredContext.join(', ')})`) : ''}`,
        );
      }
      return 0;
    case 'show': {
      const p = (await allPatterns(cwd)).find((x) => x.name === rest[0]);
      if (!p) return 1;
      for (const n of p.nodes) console.log(`${n.id.padEnd(12)} ${n.kind.padEnd(10)} ${n.label}`);
      for (const e of p.edges)
        console.log(
          c.dim(
            `${e.from} → ${e.to}${e.branch ? ` [${e.branch}]` : ''}${e.guard ? ` when ${e.guard}` : ''}`,
          ),
        );
      return 0;
    }
    case 'run':
      return cmdRun(rest, cwd);
    case 'maestro':
      return cmdMaestro(rest, cwd);
    case 'draft':
      return cmdDraft(rest, cwd);
    case 'verify':
      return cmdVerify(rest[0]);
    case 'compare':
      return cmdCompare(rest);
    case 'rehearse':
      return cmdRehearse(rest, cwd);
    case 'eval':
      return cmdEval(rest, cwd);
    case 'resume':
      return cmdContinue('resumed', rest, cwd);
    case 'fork':
      return cmdContinue('forked', rest, cwd);
    case 'runs': {
      const dir = runsDirFor(cwd);
      if (rest.includes('--prune')) {
        const dryRun = rest.includes('--dry-run');
        const r = await pruneRuns(dir, { scratchDir: join(cwd, '.symphony', 'scratch'), dryRun });
        const verb = dryRun ? 'would' : 'did';
        console.log(
          `${verb} delete ${r.deleted.length} old demo run(s), compact ${r.compacted.length} old run(s), clear ${r.scratch.length} scratch folder(s); ${(r.freed / 1e6).toFixed(1)} MB`,
        );
        for (const f of [...r.deleted, ...r.compacted]) console.log(c.dim(`  ${f}`));
        return 0;
      }
      const all = await listRuns(dir);
      const shown = rest.includes('--all') ? all : all.filter((r) => !r.demo);
      for (const r of shown)
        console.log(
          `${r.startedAt}  ${r.pattern.padEnd(12)} ${r.outcome.padEnd(10)} ${join(dir, r.file)}${r.demo ? c.dim('  (demo)') : ''}`,
        );
      const hidden = all.length - shown.length;
      if (hidden > 0) console.log(c.dim(`${hidden} offline-demo runs hidden (--all to show them)`));
      return 0;
    }
    default:
      console.log(`symphony <command>

  list                         pattern library
  show <pattern>               nodes and edges
  maestro "<request>"          compose the right score (debate by complexity), then perform it
      --compose-only  --save (write the composed score to src/patterns/drafts)
  run <pattern>                run in the terminal
      --goal "..."  -c key=value  --provider scripted|copilot  --model <id>
      --complexity 1-4  -i classical|cool|swing|bebop|free (or 0-4)
      --auto-approve  --step  --break <nodeId>  --no-save
  draft "<request>"            AI drafts a pattern (--provider copilot, --save)
  verify <run.json>            integrity + deterministic replay check
  compare <a.json> <b.json>    where two runs diverge and why (plan, environment, AI, human, engine)
  rehearse <pattern> -n 3      play the same score N times with fresh answers; per-node agreement
      --fields a,b               compare only these fields (maestro: --fields chosen,complexity)
      (takes the same options as run; approvals are auto-approved)
  resume <run.json>            continue an interrupted or stopped run from its last checkpoint
  fork <run.json> --at <step>  keep steps before <step>, play the rest again as a new run
      --provider scripted|copilot (default: the one the run used)  --model <id>  --auto-approve
  runs [--all]                 saved runs (in-progress = interrupted, resumable); --all includes demo runs
  eval [--task a,b] [-n 3] [--compare <report.json>] [--keep]   tasks with known answers: solved, citations, tokens, time
      --task routing           21 maestro requests: right pattern, complexity band and chain (compose only)
  runs --prune [--dry-run]     delete demo runs >7 days, compact runs >30 days (still replayable)

Studio (visual): npm start`);
      return cmd ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
}
