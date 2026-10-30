/**
 * `symphony eval`: run tasks with known answers and record what matters for every
 * change to Symphony: solved or not, citations valid or not, tokens, time, models.
 * A change ships only if it keeps the solved count and the citation validity.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileScore } from '../core/compile.js';
import { RUN_SCHEMA_VERSION } from '../core/migrate.js';
import type { Pattern, SavedRun, TokenUsage } from '../core/types.js';
import {
  addUsage,
  costliest,
  formatUsage,
  performanceUsage,
  rejectionUsage,
} from '../core/usage.js';
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
  /** Tokens per step of the run (rejected attempts included). */
  readonly byNode?: Readonly<Record<string, TokenUsage>>;
  readonly models: readonly string[];
  /** Workspace citations among the run's findings: how many were checked, how many held. */
  readonly citations: { readonly checked: number; readonly invalid: number };
  /** Answers thrown away: attempts, their premium requests, and answers with updates as text. */
  readonly rejected?: {
    readonly attempts: number;
    readonly premiumRequests: number;
    readonly textUpdates: number;
  };
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
  /** Save each task's run (score + performance) here, to open or replay it later. */
  readonly runsDir?: string;
  readonly onResult?: (r: EvalResult) => void;
}

async function runTask(
  task: EvalTask,
  o: EvalOptions,
  take: number,
  /** Told the run as soon as it exists, so an error later still reports what it spent. */
  onRun: (run: Run) => void = () => undefined,
): Promise<EvalResult> {
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
    const run = new Run({
      score,
      provider: o.provider(workspace, pattern),
      tools: extras.tools,
      toolContext: extras.toolContext,
      autoApprove: true,
    });
    onRun(run);
    const perf = await run.start();
    const ms = Date.now() - started;
    const state = perf.finalState;
    let saved: string | undefined;
    if (o.runsDir) {
      await mkdir(o.runsDir, { recursive: true });
      saved = join(o.runsDir, `${task.id}-${take}.json`);
      const record: SavedRun = { schemaVersion: RUN_SCHEMA_VERSION, score, performance: perf };
      await writeFile(saved, `${JSON.stringify(record, null, 2)}\n`);
    }
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
      notes: [
        ...verdict.notes,
        ...(perf.outcome !== 'success' && perf.reason ? [perf.reason] : []),
        ...(o.keep ? [`workspace ${workspace}`] : []),
        ...(saved ? [`run ${saved}`] : []),
      ],
      outcome: perf.outcome,
      ms,
      steps: perf.steps.length,
      tokens: performanceUsage(perf).total,
      byNode: performanceUsage(perf).byNode,
      rejected: (({ attempts, attemptUsage, textUpdates }) => ({
        attempts,
        premiumRequests: attemptUsage.premiumRequests ?? 0,
        textUpdates,
      }))(rejectionUsage(perf)),
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
      let played: Run | undefined;
      const r = await runTask(task, o, i + 1, (run) => (played = run)).catch(
        (e: Error): EvalResult => ({
          task: task.id,
          pattern: task.pattern,
          pass: false,
          notes: [`error: ${e.message}`],
          outcome: 'error',
          ms: 0,
          // Whatever threw, the steps the run played were paid for.
          steps: played?.engine.steps.length ?? 0,
          ...(played
            ? (({ total, byNode }) => ({ tokens: total, byNode }))(
                performanceUsage({ steps: played.engine.steps }),
              )
            : {
                tokens: {
                  calls: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  reasoningTokens: 0,
                },
              }),
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
  /** Time inside the model and billing units, when the provider reports them. */
  readonly apiMs: number;
  readonly premiumRequests: number;
  readonly rejectedAttempts: number;
  readonly rejectedPremiumRequests: number;
  readonly textUpdates: number;
  /** Composing (maestro runs) vs performing (every other pattern). */
  readonly compose: TokenUsage;
  readonly perform: TokenUsage;
  /** Tokens per "<pattern> <step>", over every run. */
  readonly byNode: Readonly<Record<string, TokenUsage>>;
}

const NO_TOKENS: TokenUsage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
};
const total = (rs: readonly EvalResult[]): TokenUsage =>
  rs.reduce((acc, r) => addUsage(acc, r.tokens), NO_TOKENS);

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
    apiMs: sum((r) => r.tokens.apiMs ?? 0),
    premiumRequests: sum((r) => r.tokens.premiumRequests ?? 0),
    // Reports from before these were recorded count as none.
    rejectedAttempts: sum((r) => r.rejected?.attempts ?? 0),
    rejectedPremiumRequests: sum((r) => r.rejected?.premiumRequests ?? 0),
    textUpdates: sum((r) => r.rejected?.textUpdates ?? 0),
    compose: total(results.filter((r) => r.pattern === 'maestro')),
    perform: total(results.filter((r) => r.pattern !== 'maestro')),
    byNode: results.reduce<Record<string, TokenUsage>>((acc, r) => {
      for (const [node, u] of Object.entries(r.byNode ?? {}))
        acc[`${r.pattern} ${node}`] = addUsage(acc[`${r.pattern} ${node}`] ?? NO_TOKENS, u);
      return acc;
    }, {}),
  };
}

const rate = (a: number, b: number) => (b === 0 ? 0 : a / b);

/** Input tokens per run may grow this much over the baseline before it counts as worse. */
export const COST_SLACK = 1.25;

/**
 * Why a run is worse than its baseline (empty = not worse): fewer tasks solved, more
 * invalid citations, no citations checked where the baseline had some (nothing
 * checked is not "all valid"), or a quarter more input tokens per run.
 */
export function regressions(s: EvalSummary, b: EvalSummary): string[] {
  const out: string[] = [];
  if (rate(s.solved, s.runs) < rate(b.solved, b.runs)) out.push('fewer tasks solved');
  if (rate(s.citationsInvalid, s.citationsChecked) > rate(b.citationsInvalid, b.citationsChecked))
    out.push('more invalid citations');
  if (s.citationsChecked === 0 && b.citationsChecked > 0) out.push('no citations checked');
  const perRun = (x: EvalSummary) => rate(x.inputTokens, x.runs);
  if (perRun(b) > 0 && perRun(s) > perRun(b) * COST_SLACK)
    out.push(`input tokens per run up ${Math.round((perRun(s) / perRun(b) - 1) * 100)}%`);
  return out;
}

export function worseThan(s: EvalSummary, b: EvalSummary): boolean {
  return regressions(s, b).length > 0;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
const pct = (a: number, b: number) =>
  b === 0 ? '' : ` (${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%)`;

const per = (x: EvalSummary, f: (x: EvalSummary) => number) => (x.runs ? f(x) / x.runs : 0);

/** One line per result, then the totals; with a baseline, the change against it. */
export function formatReport(report: EvalReport, baseline?: EvalReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.pass ? '✔' : '✘'} ${r.task.padEnd(26)} ${r.outcome.padEnd(9)} ${`${(r.ms / 1000).toFixed(0)}s`.padStart(5)} ${`${k(r.tokens.inputTokens)} in`.padStart(9)} ${`${k(r.tokens.outputTokens)} out`.padStart(9)} citations ${r.citations.checked - r.citations.invalid}/${r.citations.checked}  ${r.notes.join('; ')}`,
  );
  const s = summarize(report.results);
  const b = baseline ? summarize(baseline.results) : undefined;
  // Runs per task may differ from the baseline's: compare averages per run.
  const delta = (f: (x: EvalSummary) => number) =>
    b ? `${pct(per(s, f), per(b, f))} per run` : '';
  lines.push(
    '',
    `solved ${s.solved}/${s.runs}${b ? ` (baseline ${b.solved}/${b.runs})` : ''} · citations valid ${s.citationsChecked - s.citationsInvalid}/${s.citationsChecked}${b ? ` (baseline ${b.citationsChecked - b.citationsInvalid}/${b.citationsChecked})` : ''}`,
    `tokens ${k(s.inputTokens)} in${delta((x) => x.inputTokens)} (${k(s.cachedTokens)} cached) · ${k(s.outputTokens)} out${delta((x) => x.outputTokens)} · time ${(s.ms / 1000).toFixed(0)}s${delta((x) => x.ms)}${s.apiMs ? ` · ${(s.apiMs / 1000).toFixed(0)}s in the model` : ''}${s.premiumRequests ? ` · ${+s.premiumRequests.toFixed(2)} premium requests${delta((x) => x.premiumRequests)}` : ''}`,
  );
  if (s.rejectedAttempts || s.textUpdates)
    lines.push(
      `rejected ${s.rejectedAttempts} attempts${delta((x) => x.rejectedAttempts)} (${+s.rejectedPremiumRequests.toFixed(2)} premium requests) · ${s.textUpdates} answers sent updates as text`,
    );
  if (s.compose.calls > 0 && s.perform.calls > 0)
    lines.push(`compose ${formatUsage(s.compose)} · perform ${formatUsage(s.perform)}`);
  const top = costliest(s.byNode, 5);
  if (top.length > 0)
    lines.push(`costliest steps: ${top.map((t) => `${t.node} (${t.text})`).join('; ')}`);
  const worse = b ? regressions(s, b) : [];
  if (worse.length > 0) lines.push(`⚠ worse than the baseline: ${worse.join(', ')}`);
  return lines.join('\n');
}
