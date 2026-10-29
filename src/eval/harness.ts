/**
 * `symphony eval`: run tasks with known answers and record what matters for every
 * change to Symphony: solved or not, citations valid or not, tokens, time, models.
 * A change ships only if it keeps the solved count and the citation validity.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileScore } from '../core/compile.js';
import type { Pattern, TokenUsage } from '../core/types.js';
import { performanceUsage } from '../core/usage.js';
import { Run } from '../runtime/driver.js';
import { checkCitations } from '../runtime/evidence.js';
import { runtimeExtras } from '../runtime/factory.js';
import type { Provider } from '../runtime/provider.js';
import { buildFixture, writeFiles, type EvalTask } from './tasks.js';

export interface EvalResult {
  readonly task: string;
  readonly pattern: string;
  readonly pass: boolean;
  readonly notes: readonly string[];
  readonly outcome: string;
  readonly ms: number;
  readonly steps: number;
  readonly tokens: TokenUsage;
  readonly models: readonly string[];
  /** Workspace citations among the run's findings: how many were checked, how many held. */
  readonly citations: { readonly checked: number; readonly invalid: number };
}

export interface EvalReport {
  readonly startedAt: string;
  readonly provider: string;
  readonly results: readonly EvalResult[];
}

export interface EvalOptions {
  readonly tasks: readonly EvalTask[];
  readonly library: readonly Pattern[];
  readonly provider: (workspace: string, pattern: Pattern) => Provider;
  readonly providerName: string;
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly repeat?: number;
  /** Keep each task's workspace (printed in the notes) for a closer look. */
  readonly keep?: boolean;
  readonly onResult?: (r: EvalResult) => void;
}

async function runTask(task: EvalTask, o: EvalOptions): Promise<EvalResult> {
  const pattern = o.library.find((p) => p.name === task.pattern);
  if (!pattern) throw new Error(`eval task '${task.id}': no pattern '${task.pattern}'`);
  const workspace = await mkdtemp(join(tmpdir(), `symphony-eval-${task.id}-`));
  try {
    await buildFixture(workspace, task.files);
    // The task's workspace only: no MCP servers, no user configuration.
    const extras = await runtimeExtras(workspace, o.repoRoot, { ...o.env, SYMPHONY_MCP: 'off' });
    const score = compileScore(pattern, {
      context: task.inputs,
      ...(pattern.goalFrom ? {} : { goal: task.goal ?? task.id }),
    });
    const started = Date.now();
    const perf = await new Run({
      score,
      provider: o.provider(workspace, pattern),
      tools: extras.tools,
      toolContext: extras.toolContext,
      autoApprove: true,
    }).start();
    const ms = Date.now() - started;
    const state = perf.finalState;
    const verdict = await task.check({ workspace, outcome: perf.outcome, state });
    const findings = Array.isArray(state.findings)
      ? state.findings.filter((f): f is string => typeof f === 'string')
      : [];
    // Findings describe the code before any edit: check them against the fixture as given.
    const pristine = await mkdtemp(join(tmpdir(), `symphony-eval-${task.id}-orig-`));
    const cited = await writeFiles(pristine, task.files)
      .then(() => checkCitations(pristine, findings))
      .finally(() => rm(pristine, { recursive: true, force: true }));
    const models = [
      ...new Set(perf.steps.flatMap((s) => (s.transcript?.model ? [s.transcript.model] : []))),
    ].toSorted();
    return {
      task: task.id,
      pattern: task.pattern,
      pass: verdict.pass,
      notes: [...verdict.notes, ...(o.keep ? [`workspace ${workspace}`] : [])],
      outcome: perf.outcome,
      ms,
      steps: perf.steps.length,
      tokens: performanceUsage(perf).total,
      models,
      citations: { checked: cited.checked, invalid: cited.invalid.length },
    };
  } finally {
    if (!o.keep) await rm(workspace, { recursive: true, force: true });
  }
}

export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];
  for (const task of o.tasks) {
    for (let i = 0; i < (o.repeat ?? 1); i += 1) {
      const r = await runTask(task, o).catch(
        (e: Error): EvalResult => ({
          task: task.id,
          pattern: task.pattern,
          pass: false,
          notes: [`error: ${e.message}`],
          outcome: 'error',
          ms: 0,
          steps: 0,
          tokens: {
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
          },
          models: [],
          citations: { checked: 0, invalid: 0 },
        }),
      );
      results.push(r);
      o.onResult?.(r);
    }
  }
  return { startedAt, provider: o.providerName, results };
}

export interface EvalSummary {
  readonly runs: number;
  readonly solved: number;
  readonly citationsChecked: number;
  readonly citationsInvalid: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly ms: number;
}

export function summarize(results: readonly EvalResult[]): EvalSummary {
  const sum = (f: (r: EvalResult) => number) => results.reduce((a, r) => a + f(r), 0);
  return {
    runs: results.length,
    solved: results.filter((r) => r.pass).length,
    citationsChecked: sum((r) => r.citations.checked),
    citationsInvalid: sum((r) => r.citations.invalid),
    inputTokens: sum((r) => r.tokens.inputTokens),
    outputTokens: sum((r) => r.tokens.outputTokens),
    cachedTokens: sum((r) => r.tokens.cacheReadTokens),
    ms: sum((r) => r.ms),
  };
}

const rate = (a: number, b: number) => (b === 0 ? 0 : a / b);

/** Fewer tasks solved, or more invalid citations, per run than the baseline. */
export function worseThan(s: EvalSummary, b: EvalSummary): boolean {
  return (
    rate(s.solved, s.runs) < rate(b.solved, b.runs) ||
    rate(s.citationsInvalid, s.citationsChecked) > rate(b.citationsInvalid, b.citationsChecked)
  );
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
const pct = (a: number, b: number) =>
  b === 0 ? '' : ` (${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%)`;

/** One line per result, then the totals; with a baseline, the change against it. */
export function formatReport(report: EvalReport, baseline?: EvalReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.pass ? '✔' : '✘'} ${r.task.padEnd(26)} ${r.outcome.padEnd(9)} ${`${(r.ms / 1000).toFixed(0)}s`.padStart(5)} ${`${k(r.tokens.inputTokens)} in`.padStart(9)} ${`${k(r.tokens.outputTokens)} out`.padStart(9)} citations ${r.citations.checked - r.citations.invalid}/${r.citations.checked}  ${r.notes.join('; ')}`,
  );
  const s = summarize(report.results);
  const b = baseline ? summarize(baseline.results) : undefined;
  lines.push(
    '',
    `solved ${s.solved}/${s.runs}${b ? ` (baseline ${b.solved}/${b.runs})` : ''} · citations valid ${s.citationsChecked - s.citationsInvalid}/${s.citationsChecked}${b ? ` (baseline ${b.citationsChecked - b.citationsInvalid}/${b.citationsChecked})` : ''}`,
    `tokens ${k(s.inputTokens)} in${b ? pct(s.inputTokens, b.inputTokens) : ''} (${k(s.cachedTokens)} cached) · ${k(s.outputTokens)} out${b ? pct(s.outputTokens, b.outputTokens) : ''} · time ${(s.ms / 1000).toFixed(0)}s${b ? pct(s.ms, b.ms) : ''}`,
  );
  if (b && worseThan(s, b)) lines.push('⚠ worse than the baseline on correctness');
  return lines.join('\n');
}
