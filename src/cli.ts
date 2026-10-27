#!/usr/bin/env node
/**
 * symphony CLI. Run with `npm run cli -- <command>` (no build needed).
 *
 *   list                                   pattern library
 *   show <pattern>                         nodes and edges
 *   run <pattern> [options]                run a pattern in the terminal
 *   draft "<request>" [--save]             let the AI draft a new pattern
 *   verify <run.json>                      integrity + deterministic replay check
 *   runs                                   saved runs
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compileScore, CompileError } from './core/compile.js';
import { replayPerformance } from './core/replay.js';
import { parseFieldInput } from './core/schema.js';
import type { FieldType, Pattern } from './core/types.js';
import { PATTERNS } from './patterns/index.js';
import { Run, type RunMessage } from './runtime/driver.js';
import { draftPattern } from './runtime/drafting.js';
import {
  envConfig,
  isProviderName,
  makeProvider,
  runtimeExtras,
  type ProviderName,
} from './runtime/factory.js';
import {
  gitFingerprint,
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
  return [...PATTERNS, ...drafts.filter((d) => !PATTERNS.some((p) => p.name === d.name))];
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

async function cmdRun(argv: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      goal: { type: 'string' },
      context: { type: 'string', short: 'c', multiple: true },
      provider: { type: 'string', default: 'scripted' },
      model: { type: 'string' },
      'auto-approve': { type: 'boolean', default: false },
      break: { type: 'string', multiple: true },
      step: { type: 'boolean', default: false },
      'no-save': { type: 'boolean', default: false },
    },
  });
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
  const providerName: ProviderName = values.provider;
  const context = values.context
    ? parseContext(values.context, pattern)
    : (pattern.demo?.context ?? {});
  let score;
  try {
    score = compileScore(pattern, {
      goal: values.goal ?? pattern.demo?.goal ?? pattern.description,
      context,
    });
  } catch (e) {
    if (e instanceof CompileError) {
      console.error(c.red(e.message));
      return 1;
    }
    throw e;
  }
  const env = envConfig(process.env);
  const extras = await runtimeExtras(cwd, cwd, process.env);
  for (const s of extras.mcpSkipped) console.log(c.dim(`MCP server skipped: ${s}`));
  const run = new Run({
    score,
    tools: extras.tools,
    toolContext: extras.toolContext,
    provider: makeProvider({
      provider: providerName,
      pattern,
      workingDirectory: cwd,
      mcpServers: extras.mcpServers,
      ...env,
      ...(values.model ? { model: values.model } : {}),
    }),
    ...(pattern.demo ? { demo: pattern.demo } : {}),
    autoApprove: values['auto-approve'],
    stepMode: values.step,
    breakpoints: values.break ?? [],
    ...(providerName === 'copilot' ? { envHash: () => gitFingerprint(cwd) } : {}),
    ...(values['no-save'] ? {} : { onSave: (r) => saveRun(join(cwd, RUNS_DIR), r) }),
  });
  console.log(
    `${c.bold(pattern.name)} ${c.dim(`score ${score.id.slice(0, 12)} · provider ${providerName}`)}`,
  );
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  run.subscribe(async (m) => {
    printMessage(m, (s) => process.stdout.write(s));
    if (m.type === 'status' && m.status === 'paused') {
      if (!rl) return run.resume();
      await rl.question(c.yellow('  enter = continue '));
      run.resume();
    }
    if (m.type === 'status' && m.status === 'awaiting-approval') {
      const pause = run.engine.pause;
      if (!rl || pause?.kind !== 'approval') {
        run.answerApproval({ approved: true, scripted: true });
        return;
      }
      console.log(`\n  ${c.yellow('✋')} ${pause.message}`);
      if (pause.feedback?.length) console.log(c.red(`  ${pause.feedback.join('; ')}`));
      const updates: Record<string, unknown> = {};
      for (const f of pause.outputSchema) {
        updates[f.name] = parseContext(
          [`${f.name}=${await rl.question(`  ${f.name} (${f.type}): `)}`],
          pattern,
        )[f.name];
      }
      const ok =
        pause.outputSchema.length > 0 || !/^n/i.test(await rl.question('  approve? [Y/n] '));
      run.answerApproval({ approved: ok, updates, by: 'cli' });
    }
  });
  process.on('SIGINT', () => run.stop('interrupted'));
  const perf = await run.start();
  rl?.close();
  const saved = run.messages.find((m) => m.type === 'performance');
  if (saved?.type === 'performance' && saved.savedTo) console.log(c.dim(`saved ${saved.savedTo}`));
  console.log(c.dim(`final state ${JSON.stringify(perf.finalState)}`));
  return perf.outcome === 'failed' ? 2 : 0;
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
  const { run, issues } = await loadRun(resolve(file));
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
  return divergence.reproduced ? 0 : 2;
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const [cmd, ...rest] = argv;
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
    case 'draft':
      return cmdDraft(rest, cwd);
    case 'verify':
      return cmdVerify(rest[0]);
    case 'runs':
      for (const r of await listRuns(join(cwd, RUNS_DIR)))
        console.log(
          `${r.startedAt}  ${r.pattern.padEnd(12)} ${r.outcome.padEnd(10)} ${join(RUNS_DIR, r.file)}`,
        );
      return 0;
    default:
      console.log(`symphony <command>

  list                         pattern library
  show <pattern>               nodes and edges
  run <pattern>                run in the terminal
      --goal "..."  -c key=value  --provider scripted|copilot  --model <id>
      --auto-approve  --step  --break <nodeId>  --no-save
  draft "<request>"            AI drafts a pattern (--provider copilot, --save)
  verify <run.json>            integrity + deterministic replay check
  runs                         saved runs

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
