import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Pattern } from '../core/types.js';
import type { Provider } from '../runtime/provider.js';
import { formatReport, runEval, summarize, worseThan, type EvalReport } from './harness.js';
import { buildFixture, EVAL_TASKS, type EvalTask } from './tasks.js';

/** One executor step that "fixes" the file and reports two findings, one citation wrong. */
const mini: Pattern = {
  name: 'mini',
  description: 'one step',
  requiredContext: [],
  state: [{ name: 'findings', type: 'string[]' }],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'work',
      kind: 'agent',
      role: 'executor',
      label: 'Work',
      directive: 'fix it',
      reads: [],
      writes: ['findings'],
    },
    { id: 'end', kind: 'end', label: 'End', outcome: 'success' },
  ],
  edges: [
    { id: 'a', from: 'start', to: 'work' },
    { id: 'b', from: 'work', to: 'end' },
  ],
};

const task: EvalTask = {
  id: 'mini-task',
  pattern: 'mini',
  inputs: {},
  files: { 'a.txt': 'broken\n' },
  check: async ({ workspace }) => ({
    pass: readFileSync(join(workspace, 'a.txt'), 'utf8') === 'fixed\n',
    notes: ['a.txt fixed'],
  }),
};

const fakeProvider =
  (fix: boolean) =>
  (workspace: string): Provider => ({
    name: 'fake',
    runAgent: async () => {
      if (fix) writeFileSync(join(workspace, 'a.txt'), 'fixed\n');
      return {
        result: {
          updates: { findings: ['a.txt:1 — the text `broken`', 'a.txt:9 — no such line'] },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        },
        transcript: {
          provider: 'fake',
          model: 'fake-model',
          prompt: '',
          output: '',
          toolCalls: [],
          usage: {
            calls: 1,
            inputTokens: 1000,
            outputTokens: 50,
            cacheReadTokens: 400,
            reasoningTokens: 0,
          },
        },
      };
    },
    draft: () => Promise.reject(new Error('n/a')),
  });

const evaluate = (fix: boolean, repeat = 1) =>
  runEval({
    tasks: [task],
    library: [mini],
    provider: fakeProvider(fix),
    providerName: 'fake',
    repoRoot: process.cwd(),
    env: {},
    repeat,
  });

describe('eval harness', () => {
  it('runs each task in a fresh fixture and records solved, citations, tokens and models', async () => {
    const report = await evaluate(true, 2);
    expect(report.results[0]!.notes).toEqual(['a.txt fixed']);
    expect(report.results).toHaveLength(2);
    const [r] = report.results;
    expect(r).toMatchObject({
      task: 'mini-task',
      pass: true,
      outcome: 'success',
      steps: 3,
      models: ['fake-model'],
      citations: { checked: 2, invalid: 1 },
    });
    expect(r!.tokens).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 50 });
    expect(summarize(report.results)).toMatchObject({ runs: 2, solved: 2, inputTokens: 2000 });
  });

  it('reports failures and flags a run that is worse than its baseline', async () => {
    const baseline = await evaluate(true);
    const worse = await evaluate(false);
    expect(worse.results[0]!.pass).toBe(false);
    expect(worseThan(summarize(worse.results), summarize(baseline.results))).toBe(true);
    const text = formatReport(worse, baseline);
    expect(text).toMatch(/✘ mini-task/);
    expect(text).toMatch(/solved 0\/1 \(baseline 1\/1\)/);
    expect(text).toMatch(/citations valid 1\/2/);
    expect(text).toMatch(/⚠ worse than the baseline on correctness/);
    expect(formatReport(baseline, baseline)).not.toMatch(/⚠/);
    // Two runs against a baseline of one: compared per run, not in total.
    const twice = await evaluate(true, 2);
    expect(formatReport(twice, baseline)).toMatch(/tokens 2\.0k in \(\+0%\) per run/);
  });

  it('an unknown pattern is a failed result, not a crash', async () => {
    const report: EvalReport = await runEval({
      tasks: [{ ...task, pattern: 'nope' }],
      library: [mini],
      provider: fakeProvider(true),
      providerName: 'fake',
      repoRoot: process.cwd(),
      env: {},
    });
    expect(report.results[0]).toMatchObject({ pass: false, outcome: 'error' });
    expect(report.results[0]!.notes[0]).toMatch(/no pattern 'nope'/);
  });
});

/** What a right answer looks like for each task, to prove its check can tell. */
const SOLUTIONS: Record<string, (dir: string) => { state: Record<string, unknown> }> = {
  'fix-off-by-one': (dir) => {
    const f = join(dir, 'src/sum.js');
    writeFileSync(f, readFileSync(f, 'utf8').replace('i < n', 'i <= n'));
    return { state: {} };
  },
  'fix-wrong-index': (dir) => {
    const f = join(dir, 'src/caps.js');
    writeFileSync(f, readFileSync(f, 'utf8').replace('charAt(1)', 'charAt(0)'));
    return { state: {} };
  },
  'implement-json-option': (dir) => {
    const f = join(dir, 'src/list.js');
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace(
        '  return items',
        '  if (options.json) return JSON.stringify(items);\n  return items',
      ),
    );
    return { state: {} };
  },
  'refactor-extract': (dir) => {
    writeFileSync(
      join(dir, 'src/price.js'),
      'export function discount(price, percent) {\n  return Math.round(price - (price * percent) / 100);\n}\nexport const memberPrice = (p) => discount(p, 10);\nexport const salePrice = (p) => discount(p, 25);\n',
    );
    return { state: {} };
  },
  'fix-cause-elsewhere': (dir) => {
    const f = join(dir, 'src/money.js');
    writeFileSync(f, readFileSync(f, 'utf8').replace('(line.qty ? 1 : 0)', 'line.qty'));
    return { state: {} };
  },
  'investigate-multi-hop': () => ({
    state: {
      answer:
        'It waits 45 seconds: src/defaults.js sets 30, src/overrides.js doubles it to 60, and src/client.js subtracts 15.',
    },
  }),
  'investigate-false-premise': () => ({
    state: {
      answer: 'It does not retry at all: fetchUser calls http.get once and throws on failure.',
    },
  }),
  'investigate-default-port': () => ({
    state: { answer: 'It listens on 8081: loadConfig in src/config.js uses DEFAULTS.port + 1.' },
  }),
};

describe('eval tasks', () => {
  it.each(EVAL_TASKS.map((t) => [t.id, t] as const))(
    '%s: the check fails as given and passes with a right answer',
    async (_id, t) => {
      const solve = SOLUTIONS[t.id];
      expect(solve).toBeDefined();
      const dir = await mkdtemp(join(tmpdir(), 'symphony-evaltask-'));
      try {
        await buildFixture(dir, t.files);
        const wrong: Record<string, unknown> =
          t.pattern !== 'investigate'
            ? {}
            : t.id === 'investigate-false-premise'
              ? { answer: 'It retries three times because the network is flaky.' }
              : { answer: 'The README says 30 seconds; the docs say port 8080.' };
        expect((await t.check({ workspace: dir, outcome: 'success', state: wrong })).pass).toBe(
          false,
        );
        const { state } = solve!(dir);
        const right = await t.check({ workspace: dir, outcome: 'success', state });
        expect(right.notes.join('; ')).not.toMatch(/fail|missing/);
        expect(right.pass).toBe(true);
        // A run that did not succeed never counts as solved, even with the right files.
        if (t.pattern !== 'investigate')
          expect((await t.check({ workspace: dir, outcome: 'failed', state })).pass).toBe(false);
        expect(existsSync(join(dir, '.git'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
