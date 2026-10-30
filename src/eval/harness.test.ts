import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Pattern } from '../core/types.js';
import type { Provider } from '../runtime/provider.js';
import {
  formatReport,
  regressions,
  runEval,
  summarize,
  worseThan,
  type EvalReport,
} from './harness.js';
import {
  buildFixture,
  EVAL_TASKS,
  requirementCoverage,
  ROUTES,
  ROUTING_TASKS,
  routedAs,
  type EvalTask,
} from './tasks.js';
import { workPatternNames } from '../patterns/index.js';

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
  files: { 'a.txt': 'broken line\n' },
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
          updates: { findings: ['a.txt:1 — the text `broken line`', 'a.txt:9 — no such line'] },
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
    expect(r!.byNode).toEqual({ work: r!.tokens });
    const s = summarize(report.results);
    expect(s).toMatchObject({ runs: 2, solved: 2, inputTokens: 2000 });
    // Per step over every run, and composing (maestro) apart from performing.
    expect(s.byNode['mini work']).toMatchObject({ calls: 2, inputTokens: 2000 });
    expect(s.perform).toMatchObject({ calls: 2, inputTokens: 2000 });
    expect(s.compose.calls).toBe(0);
    expect(formatReport(report)).toMatch(
      /costliest steps: mini work \(2k in \(800 cached\) · 100 out · 2 calls\)/,
    );
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
    expect(text).toMatch(/⚠ worse than the baseline: fewer tasks solved/);
    expect(formatReport(baseline, baseline)).not.toMatch(/⚠/);
    // Cost counts too, and nothing checked is not "all valid".
    const base = summarize(baseline.results);
    expect(regressions({ ...base, inputTokens: base.inputTokens * 2 }, base)).toEqual([
      'input tokens per run up 100%',
    ]);
    expect(regressions({ ...base, citationsChecked: 0, citationsInvalid: 0 }, base)).toEqual([
      'no citations checked',
    ]);
    // Two runs against a baseline of one: compared per run, not in total.
    const twice = await evaluate(true, 2);
    expect(formatReport(twice, baseline)).toMatch(/tokens 2\.0k in \(\+0%\) per run/);
  });

  it('a run that errors after playing still reports the tokens it spent', async () => {
    const report = await runEval({
      tasks: [{ ...task, check: () => Promise.reject(new Error('check crashed')) }],
      library: [mini],
      provider: fakeProvider(true),
      providerName: 'fake',
      repoRoot: process.cwd(),
      env: {},
    });
    expect(report.results[0]).toMatchObject({ outcome: 'error', notes: ['error: check crashed'] });
    expect(report.results[0]!.tokens).toMatchObject({ calls: 1, inputTokens: 1000 });
    expect(report.results[0]!.byNode).toMatchObject({ work: { calls: 1 } });
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
  'maestro-requirements': () => ({
    state: {
      requirements: [
        'Fix sumTo so it includes n',
        'Run the existing tests before changing anything',
        'Change only src/sum.js',
      ],
      coverage: [
        'R1: apply — edits sumTo to include n',
        'R2: baseline — runs the tests first',
        'R3: apply — guidance: edit only src/sum.js',
      ],
      uncovered: [],
      finalPattern: {
        nodes: [
          { id: 'baseline', label: 'Run tests first', tool: 'tests.run' },
          {
            id: 'apply',
            label: 'Edit',
            directive: 'Implement the plan. For this request: edit only src/sum.js.',
          },
        ],
      },
    },
  }),
  'investigate-default-port': () => ({
    state: { answer: 'It listens on 8081: loadConfig in src/config.js uses DEFAULTS.port + 1.' },
  }),
};

for (const [i, route] of ROUTES.entries())
  SOLUTIONS[ROUTING_TASKS[i]!.id] = () => ({
    state: {
      chosen: route.pattern[0],
      complexity: route.complexity[1],
      thenPattern: route.thenPattern ?? '',
    },
  });

describe('eval tasks', () => {
  it.each([...EVAL_TASKS, ...ROUTING_TASKS].map((t) => [t.id, t] as const))(
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

const right = SOLUTIONS['maestro-requirements']!('').state;
const judge = (state: Record<string, unknown>) =>
  requirementCoverage('success', state, [/\btests?\b/i]);

describe('requirement coverage judge', () => {
  it('fails form without substance: a step that does not exist, or one not about the requirement', () => {
    expect(judge(right).pass).toBe(true);
    const ghost = judge({
      ...right,
      coverage: ['R1: apply — x', 'R2: runTests — x', 'R3: apply — x'],
    });
    expect(ghost.notes.join()).toMatch(/R2 names no step of the score/);
    const anyStep = judge({
      ...right,
      coverage: ['R1: apply — x', 'R2: apply — runs tests', 'R3: apply — x'],
    });
    expect(anyStep.notes.join()).toMatch(
      /R2 \(\\btests\?\\b\) maps to 'apply', a step not about it/,
    );
    expect(judge({ ...right, uncovered: ['R3: NOT COVERED — x'] }).pass).toBe(false);
    expect(judge({ ...right, coverage: ['R1: apply — x'] }).pass).toBe(false);
    expect(requirementCoverage('partial', right, []).pass).toBe(false);
  });
});

describe('routing judge', () => {
  const route = ROUTES.find((r) => r.thenPattern === 'fix')!;
  const ok = { chosen: 'investigate', complexity: 3, thenPattern: 'fix' };
  it('checks the pattern, the complexity band and the chain', () => {
    expect(routedAs('success', ok, route).pass).toBe(true);
    expect(routedAs('success', { ...ok, chosen: 'fix' }, route).notes.join()).toMatch(
      /routed to 'fix', expected investigate/,
    );
    expect(routedAs('success', { ...ok, complexity: 1 }, route).notes.join()).toMatch(
      /complexity 1, expected 2-4/,
    );
    expect(routedAs('success', { ...ok, thenPattern: '' }, route).notes.join()).toMatch(
      /then '', expected 'fix'/,
    );
    expect(routedAs('partial', ok, route).pass).toBe(false);
  });

  it('every route names a work pattern (or new), never a demo game', () => {
    const known = new Set([...workPatternNames(), 'new']);
    expect(ROUTES.length).toBeGreaterThanOrEqual(20);
    for (const r of ROUTES) {
      for (const p of [...r.pattern, ...(r.thenPattern ? [r.thenPattern] : [])])
        expect(known).toContain(p);
      expect(r.complexity[0]).toBeLessThanOrEqual(r.complexity[1]);
    }
    expect(new Set(ROUTING_TASKS.map((t) => t.id)).size).toBe(ROUTES.length);
  });
});
