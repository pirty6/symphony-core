/**
 * Eval tasks: small workspaces with a known right answer. Each task builds its
 * fixture, names the pattern and inputs to run, and checks the outcome with code
 * (hidden tests, exact facts), never by asking an AI.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface EvalContext {
  readonly workspace: string;
  readonly outcome: string;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface EvalCheck {
  readonly pass: boolean;
  readonly notes: readonly string[];
}

export interface EvalTask {
  readonly id: string;
  readonly pattern: string;
  /** For patterns without goalFrom (the goal is otherwise one of the inputs). */
  readonly goal?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
  /** Written after the fixture is committed: uncommitted work (e.g. for a review). */
  readonly changes?: Readonly<Record<string, string>>;
  readonly check: (ctx: EvalContext) => Promise<EvalCheck>;
}

/** Write the fixture and commit it, so editing patterns have a clean git baseline. */
export async function writeFiles(dir: string, files: Readonly<Record<string, string>>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

export async function buildFixture(dir: string, files: Readonly<Record<string, string>>) {
  await writeFiles(dir, files);
  const git = (...args: string[]) => run('git', args, { cwd: dir });
  await git('init', '-q');
  await git('add', '-A');
  await git('-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-qm', 'fixture');
}

/** Run node's test runner on some files in the workspace; pass = exit code 0. */
export async function nodeTests(dir: string, ...files: string[]): Promise<EvalCheck> {
  try {
    await run(process.execPath, ['--test', ...files], { cwd: dir, timeout: 60_000 });
    return { pass: true, notes: [`tests pass: ${files.join(' ')}`] };
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}`.split('\n');
    return {
      pass: false,
      notes: [
        `tests fail: ${files.join(' ')}`,
        ...out.filter((l) => /not ok|Error/.test(l)).slice(0, 3),
      ],
    };
  }
}

/** Every fact must appear in the text (case-insensitive). */
export function mentions(text: string, facts: readonly string[]): EvalCheck {
  const missing = facts.filter((f) => !text.toLowerCase().includes(f.toLowerCase()));
  return {
    pass: missing.length === 0,
    notes: missing.length ? [`missing: ${missing.join(', ')}`] : [`mentions ${facts.join(', ')}`],
  };
}

const both = (...checks: EvalCheck[]): EvalCheck => ({
  pass: checks.every((c) => c.pass),
  notes: checks.flatMap((c) => c.notes),
});
const succeeded = (outcome: string): EvalCheck => ({
  pass: outcome === 'success',
  notes: [`outcome ${outcome}`],
});

interface ScoreNodeLike {
  readonly id: string;
  readonly label?: string;
  readonly directive?: string;
  readonly tool?: string;
}

/**
 * Requirement coverage of a maestro composition, judged by code: every requirement
 * in the ledger maps to a step that exists in the approved score, none is uncovered,
 * and each requirement matching one of `must` maps to a step that is about it (its
 * label, directive or tool matches too), not to just any step.
 */
export function requirementCoverage(
  outcome: string,
  state: Readonly<Record<string, unknown>>,
  must: readonly RegExp[],
): EvalCheck {
  const nodes = (
    (state.finalPattern as { nodes?: ScoreNodeLike[] } | undefined)?.nodes ?? []
  ).filter(Boolean);
  const requirements = (state.requirements as string[] | undefined) ?? [];
  const coverage = (state.coverage as string[] | undefined) ?? [];
  const uncovered = (state.uncovered as string[] | undefined) ?? [];
  const notes: string[] = [];
  if (nodes.length === 0) notes.push('missing: no composed score');
  if (requirements.length === 0) notes.push('missing: no requirements listed');
  if (coverage.length !== requirements.length)
    notes.push(`fail: ${coverage.length} coverage entries for ${requirements.length} requirements`);
  if (uncovered.length > 0) notes.push(`fail: not covered: ${uncovered.join('; ')}`);
  const stepOf = (entry: string | undefined) =>
    nodes.find((n) => n.id === /^R\d+:\s*([\w-]+)/.exec(entry ?? '')?.[1]);
  coverage.forEach((c, i) => {
    if (!stepOf(c)) notes.push(`fail: R${i + 1} names no step of the score: ${c.slice(0, 120)}`);
  });
  for (const re of must) {
    const i = requirements.findIndex((r) => re.test(r));
    if (i < 0) {
      notes.push(`missing: a requirement about ${re.source}`);
      continue;
    }
    const step = stepOf(coverage[i]);
    if (step && !re.test(`${step.label ?? ''} ${step.directive ?? ''} ${step.tool ?? ''}`))
      notes.push(`fail: R${i + 1} (${re.source}) maps to '${step.id}', a step not about it`);
  }
  const pass = outcome === 'success' && notes.length === 0;
  return {
    pass,
    notes: [
      `outcome ${outcome}`,
      ...(notes.length ? notes : [`${requirements.length} requirements, each met by a step`]),
    ],
  };
}

const PKG = '{ "name": "fixture", "type": "module", "scripts": { "test": "node --test" } }\n';
const IGNORE = '.symphony/\nnode_modules/\n';
const SUM_RIGHT =
  '/** Sum of the numbers from 1 to n. */\nexport function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\n';
const TEST_HEAD = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";

/** A task whose check runs the visible tests plus a hidden one the AI never saw. */
function withHiddenTest(task: Omit<EvalTask, 'check'>, visible: string, hidden: string): EvalTask {
  return {
    ...task,
    check: async ({ workspace, outcome }) => {
      await writeFile(join(workspace, 'test', 'hidden-eval.test.js'), TEST_HEAD + hidden);
      return both(
        succeeded(outcome),
        await nodeTests(workspace, visible, 'test/hidden-eval.test.js'),
      );
    },
  };
}

export const EVAL_TASKS: readonly EvalTask[] = [
  withHiddenTest(
    {
      id: 'fix-off-by-one',
      pattern: 'fix',
      inputs: {
        issue: 'sumTo(4) returns 6 instead of 10: the sum should include n (see test/sum.test.js)',
        testCommand: 'node --test test/sum.test.js',
      },
      files: {
        'package.json': PKG,
        '.gitignore': IGNORE,
        'src/sum.js':
          '/** Sum of the numbers from 1 to n. */\nexport function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n',
        'test/sum.test.js': `${TEST_HEAD}import { sumTo } from '../src/sum.js';\ntest('sumTo includes n', () => assert.equal(sumTo(4), 10));\n`,
      },
    },
    'test/sum.test.js',
    "import { sumTo } from '../src/sum.js';\ntest('edges', () => { assert.equal(sumTo(1), 1); assert.equal(sumTo(0), 0); assert.equal(sumTo(100), 5050); });\n",
  ),
  withHiddenTest(
    {
      id: 'fix-wrong-index',
      pattern: 'fix',
      inputs: {
        issue:
          'titleCase("hello big world") should return "Hello Big World" (see test/caps.test.js)',
        testCommand: 'node --test test/caps.test.js',
      },
      files: {
        'package.json': PKG,
        '.gitignore': IGNORE,
        'src/caps.js':
          "/** Capitalize the first letter of every word. */\nexport function titleCase(s) {\n  return s.split(' ').map((w) => w.charAt(1).toUpperCase() + w.slice(1)).join(' ');\n}\n",
        'test/caps.test.js': `${TEST_HEAD}import { titleCase } from '../src/caps.js';\ntest('capitalizes each word', () => assert.equal(titleCase('hello big world'), 'Hello Big World'));\n`,
      },
    },
    'test/caps.test.js',
    "import { titleCase } from '../src/caps.js';\ntest('edges', () => { assert.equal(titleCase('a'), 'A'); assert.equal(titleCase('already Up'), 'Already Up'); });\n",
  ),
  withHiddenTest(
    {
      id: 'implement-json-option',
      pattern: 'implement',
      inputs: {
        request:
          'Add a `json` option to formatList(items, options) in src/list.js: when options.json is true it returns JSON.stringify(items); without it the output stays exactly as today.',
        testCommand: 'node --test',
      },
      files: {
        'package.json': PKG,
        '.gitignore': IGNORE,
        'src/list.js':
          "/** One item per line, each prefixed with '- '. */\nexport function formatList(items, options = {}) {\n  return items.map((i) => `- ${i}`).join('\\n');\n}\n",
        'test/list.test.js': `${TEST_HEAD}import { formatList } from '../src/list.js';\ntest('one per line', () => assert.equal(formatList(['a', 'b']), '- a\\n- b'));\n`,
      },
    },
    'test/list.test.js',
    "import { formatList } from '../src/list.js';\ntest('json', () => { assert.equal(formatList(['a', 'b'], { json: true }), '[\"a\",\"b\"]'); assert.equal(formatList(['a'], { json: false }), '- a'); assert.equal(formatList([]), ''); });\n",
  ),
  withHiddenTest(
    {
      id: 'refactor-extract',
      pattern: 'refactor',
      inputs: {
        target:
          'Extract the duplicated discount arithmetic in src/price.js into one exported function discount(price, percent) that returns the rounded discounted price, and use it in both callers.',
        testCommand: 'node --test',
      },
      files: {
        'package.json': PKG,
        '.gitignore': IGNORE,
        'src/price.js':
          'export function memberPrice(price) {\n  return Math.round(price - (price * 10) / 100);\n}\n\nexport function salePrice(price) {\n  return Math.round(price - (price * 25) / 100);\n}\n',
        'test/price.test.js': `${TEST_HEAD}import { memberPrice, salePrice } from '../src/price.js';\ntest('prices', () => { assert.equal(memberPrice(100), 90); assert.equal(salePrice(80), 60); });\n`,
      },
    },
    'test/price.test.js',
    "import * as m from '../src/price.js';\ntest('extracted, same behaviour', () => { assert.equal(typeof m.discount, 'function'); assert.equal(m.discount(200, 10), 180); assert.equal(m.memberPrice(55), 50); assert.equal(m.salePrice(55), 41); });\n",
  ),
  {
    id: 'investigate-default-port',
    pattern: 'investigate',
    inputs: {
      question:
        'Which port does the server listen on when the PORT environment variable is not set, and in which file and function is that default decided?',
    },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'README.md': '# demo server\n\nRun `node src/server.js`. The port is configurable.\n',
      'src/server.js':
        "import { createServer } from 'node:http';\nimport { loadConfig } from './config.js';\n\nconst { port } = loadConfig(process.env);\ncreateServer((_q, res) => res.end('ok')).listen(port);\n",
      'src/config.js':
        "import { DEFAULTS } from './defaults.js';\n\nexport function loadConfig(env) {\n  const port = env.PORT ? Number(env.PORT) : DEFAULTS.port + 1;\n  return { port };\n}\n",
      'src/defaults.js': 'export const DEFAULTS = { port: 8080, host: "0.0.0.0" };\n',
      'docs/ops.md': 'The service listens on port 8080 by default.\n',
    },
    // The docs say 8080, but the code adds 1: the right answer needs reading the code.
    // A right answer from a run that did not succeed (e.g. ended with doubts) is not solved.
    check: async ({ outcome, state }) =>
      both(
        succeeded(outcome),
        mentions(String(state.answer ?? ''), ['8081', 'src/config.js', 'loadConfig']),
      ),
  },
  withHiddenTest(
    {
      id: 'fix-cause-elsewhere',
      pattern: 'fix',
      inputs: {
        issue:
          'cartTotal([{ price: 10, qty: 3 }]) returns 10 instead of 30 (see test/cart.test.js)',
        testCommand: 'node --test test/cart.test.js',
      },
      files: {
        'package.json': PKG,
        '.gitignore': IGNORE,
        'src/cart.js':
          "import { lineTotal } from './money.js';\n\nexport function cartTotal(lines) {\n  return lines.reduce((sum, l) => sum + lineTotal(l), 0);\n}\n",
        // The symptom is in cart.js; the cause is here.
        'src/money.js':
          'export function lineTotal(line) {\n  return line.price * (line.qty ? 1 : 0);\n}\n',
        'test/cart.test.js': `${TEST_HEAD}import { cartTotal } from '../src/cart.js';\ntest('sums price x qty', () => assert.equal(cartTotal([{ price: 10, qty: 3 }]), 30));\n`,
      },
    },
    'test/cart.test.js',
    "import { lineTotal } from '../src/money.js';\ntest('lineTotal', () => { assert.equal(lineTotal({ price: 2, qty: 5 }), 10); assert.equal(lineTotal({ price: 7, qty: 0 }), 0); });\n",
  ),
  {
    id: 'investigate-multi-hop',
    pattern: 'investigate',
    inputs: {
      question:
        'With no environment variables set, how many seconds does a request wait before it times out, and which files decide it?',
    },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/defaults.js': 'export const DEFAULTS = { timeoutSeconds: 30, retries: 0 };\n',
      'src/overrides.js':
        "import { DEFAULTS } from './defaults.js';\n\n// Production profile: double the default.\nexport const PROFILE = { ...DEFAULTS, timeoutSeconds: DEFAULTS.timeoutSeconds * 2 };\n",
      'src/client.js':
        "import { PROFILE } from './overrides.js';\n\nexport function timeoutMs(env = process.env) {\n  const seconds = env.TIMEOUT ? Number(env.TIMEOUT) : PROFILE.timeoutSeconds - 15;\n  return seconds * 1000;\n}\n",
      'README.md': '# client\n\nRequests time out after 30 seconds by default.\n',
    },
    // defaults 30 -> overrides x2 = 60 -> client - 15 = 45; the README's 30 is stale.
    check: async ({ outcome, state }) =>
      both(
        succeeded(outcome),
        mentions(String(state.answer ?? ''), ['45', 'src/client.js', 'src/overrides.js']),
      ),
  },
  {
    id: 'investigate-false-premise',
    pattern: 'investigate',
    inputs: {
      question: 'Why does fetchUser retry failed requests three times before giving up?',
    },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/users.js':
        'export async function fetchUser(id, http) {\n  const res = await http.get(`/users/${id}`);\n  if (!res.ok) throw new Error(`user ${id}: ${res.status}`);\n  return res.json();\n}\n',
      'src/http.js':
        'export const http = {\n  get: (path) => fetch(`https://api.example.com${path}`),\n};\n',
    },
    // There is no retry at all: the right answer says so instead of explaining one.
    check: async ({ outcome, state }) => {
      const answer = String(state.answer ?? '');
      const denies = /\b(no|not|never|doesn't|does not|without)\b[^.]{0,60}\bretr/i.test(answer);
      const invents = /retr\w*[^.]{0,40}\b(three|3) times\b[^.]{0,40}\bbecause\b/i.test(answer);
      return {
        pass: outcome === 'success' && denies && !invents,
        notes: [
          `outcome ${outcome}`,
          denies ? 'says there is no retry' : 'does not say there is no retry',
          ...(invents ? ['explains a retry that does not exist'] : []),
        ],
      };
    },
  },
  {
    // The maestro, judged on what it composed: every requirement met by a real step.
    id: 'maestro-requirements',
    pattern: 'maestro',
    inputs: {
      request:
        'Fix sumTo in src/sum.js: sumTo(4) returns 6 instead of 10. Requirements: run the existing tests before changing anything, and change only src/sum.js.',
    },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/sum.js':
        '/** Sum of the numbers from 1 to n. */\nexport function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n',
      'test/sum.test.js': `${TEST_HEAD}import { sumTo } from '../src/sum.js';\ntest('sumTo includes n', () => assert.equal(sumTo(4), 10));\n`,
    },
    check: async ({ outcome, state }) => requirementCoverage(outcome, state, [/\btests?\b/i]),
  },
  {
    // A review of uncommitted work with one real bug: found, cited, and not called clean.
    id: 'review-off-by-one',
    pattern: 'review',
    inputs: { target: 'the uncommitted changes in the working tree (git diff)' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/sum.js': SUM_RIGHT,
      'src/greet.js': 'export const greet = (name) => `Hello, ${name}!`;\n',
    },
    changes: {
      'src/sum.js': SUM_RIGHT.replace('i <= n', 'i < n'),
      'src/greet.js':
        '/** Greets someone by name. */\nexport const greet = (name) => `Hello, ${name}!`;\n',
    },
    check: async ({ outcome, state }) => {
      const findings = ((state.findings as string[] | undefined) ?? []).join('\n');
      const hit = /src\/sum\.js:\d+/.test(findings);
      return {
        pass: outcome === 'success' && hit,
        notes: [
          `outcome ${outcome}`,
          hit ? 'found the bug in src/sum.js' : 'missing: no finding cites src/sum.js',
        ],
      };
    },
  },
  {
    // An analysis judged on its answer and on citing the numbers it rests on.
    id: 'analyze-top-region',
    pattern: 'analyze',
    inputs: {
      question: 'Which region had the highest total revenue, and by how much over the next one?',
      data: 'data/sales.csv',
    },
    files: {
      '.gitignore': IGNORE,
      'data/sales.csv':
        [
          'date,region,revenue',
          '2026-01-05,EU,1200',
          '2026-01-06,US,900',
          '2026-01-07,EU,800',
          '2026-01-08,APAC,700',
          '2026-01-09,US,600',
          '2026-01-10,APAC,650',
        ].join('\n') + '\n',
    },
    check: async ({ outcome, state }) => {
      const conclusion = String(state.conclusion ?? '');
      const notes = [
        ...(/\bEU\b/.test(conclusion) ? [] : ['fail: the conclusion does not name EU (2000)']),
        ...(/\b500\b/.test(conclusion) ? [] : ['fail: the margin over US (500) is missing']),
        ...(/\[F\d+\]/.test(conclusion) ? [] : ['missing: the conclusion cites no finding']),
      ];
      return {
        pass: outcome === 'success' && notes.length === 0,
        notes: [`outcome ${outcome}`, ...(notes.length ? notes : ['EU by 500, cited'])],
      };
    },
  },
  {
    // A backlog judged on what it extracts: each real item once, the done one skipped.
    id: 'backlog-extract',
    pattern: 'backlog',
    inputs: { source: 'docs/improvements.md' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/sum.js': SUM_RIGHT,
      'src/greet.js': 'export const greet = (name) => `Hello, ${name}!`;\n',
      'docs/improvements.md':
        [
          '# Improvements',
          '',
          '- sumTo should throw a RangeError for negative n (src/sum.js).',
          '- greet should trim the name before greeting (src/greet.js).',
          '- sumTo should include n itself (already done).',
        ].join('\n') + '\n',
    },
    check: async ({ outcome, state }) => {
      const items = (state.items as string[] | undefined) ?? [];
      const notes = [
        ...(items.length === 2 ? [] : [`fail: ${items.length} items, expected 2`]),
        ...(items.some((i) => /sum/i.test(i) && /negative|RangeError/i.test(i))
          ? []
          : ['missing: the negative-n item']),
        ...(items.some((i) => /greet/i.test(i) && /trim/i.test(i))
          ? []
          : ['missing: the trim item']),
      ];
      return {
        pass: outcome === 'success' && notes.length === 0,
        notes: [
          `outcome ${outcome}`,
          ...(notes.length ? notes : ['2 items, the done one skipped']),
        ],
      };
    },
  },
];

/** Where the maestro should route a request: any of `pattern`, at a tier in `complexity`. */
export interface Route {
  readonly request: string;
  readonly pattern: readonly string[];
  readonly complexity: readonly [number, number];
  /** The pattern chained after it ('' or absent = none). */
  readonly thenPattern?: string;
}

/** Judge a maestro composition on its routing only: pattern, complexity band and chain. */
export function routedAs(
  outcome: string,
  state: Readonly<Record<string, unknown>>,
  route: Route,
): EvalCheck {
  const chosen = String(state.chosen ?? '');
  const complexity = Number(state.complexity);
  const then = String(state.thenPattern ?? '');
  const [lo, hi] = route.complexity;
  const notes = [
    ...(route.pattern.includes(chosen)
      ? []
      : [`fail: routed to '${chosen || 'nothing'}', expected ${route.pattern.join(' or ')}`]),
    ...(complexity >= lo && complexity <= hi
      ? []
      : [`fail: complexity ${state.complexity ?? 'missing'}, expected ${lo}-${hi}`]),
    ...(then === (route.thenPattern ?? '')
      ? []
      : [`fail: then '${then}', expected '${route.thenPattern ?? ''}'`]),
  ];
  return {
    pass: outcome === 'success' && notes.length === 0,
    notes: [
      `outcome ${outcome}`,
      ...(notes.length ? notes : [`${chosen} at ${complexity}${then ? ` then ${then}` : ''}`]),
    ],
  };
}

/**
 * About twenty requests with the route a careful person would pick. Bands are wide on
 * purpose: they catch a wrong shape or a wildly wrong tier, not a one-tier judgement call.
 */
export const ROUTES: readonly Route[] = [
  {
    request: 'Fix the off-by-one in sumTo in src/sum.js: sumTo(4) returns 6, not 10.',
    pattern: ['fix'],
    complexity: [1, 2],
  },
  {
    request: 'npm test fails on main since yesterday; make it pass again.',
    pattern: ['fix'],
    complexity: [2, 3],
  },
  {
    request: 'The login page crashes with a null pointer after the last deploy. Find and fix it.',
    pattern: ['fix'],
    complexity: [2, 3],
  },
  {
    request: 'The dashboard totals are wrong.',
    pattern: ['fix', 'investigate'],
    complexity: [2, 4],
  },
  {
    request: 'Why does the server listen on port 8081 instead of 8080?',
    pattern: ['investigate'],
    complexity: [1, 2],
  },
  {
    request: 'How does the retry logic in src/http.js work?',
    pattern: ['investigate'],
    complexity: [1, 2],
  },
  {
    request: 'Explain the architecture of this repository.',
    pattern: ['investigate'],
    complexity: [1, 3],
  },
  {
    request: 'Is our session handling vulnerable to session fixation? Show the evidence.',
    pattern: ['investigate', 'review'],
    complexity: [2, 4],
  },
  {
    request: 'Find out why the build is slow, then fix it.',
    pattern: ['investigate'],
    complexity: [2, 4],
    thenPattern: 'fix',
  },
  {
    request: 'Understand src/billing and then clean it up.',
    pattern: ['investigate'],
    complexity: [2, 4],
    thenPattern: 'refactor',
  },
  {
    request: 'Rename the util module to helpers without changing behaviour.',
    pattern: ['refactor'],
    complexity: [1, 2],
  },
  {
    request: 'Split the 2,000-line src/server.js into modules without changing behaviour.',
    pattern: ['refactor'],
    complexity: [2, 4],
  },
  { request: 'Add a --verbose flag to the CLI.', pattern: ['implement'], complexity: [1, 2] },
  { request: 'Add GitHub OAuth login to the web app.', pattern: ['implement'], complexity: [3, 4] },
  { request: 'Review my branch before I merge it.', pattern: ['review'], complexity: [1, 3] },
  {
    request: 'Review the diff of PR #42 for security risks.',
    pattern: ['review'],
    complexity: [2, 3],
  },
  {
    request: 'Which product sold best last quarter in data/sales.csv?',
    pattern: ['analyze'],
    complexity: [1, 3],
  },
  {
    request: 'Do support tickets in data/tickets.csv spike after releases?',
    pattern: ['analyze'],
    complexity: [2, 3],
  },
  {
    request: 'Go through IMPROVEMENTS.md and do each item as its own change.',
    pattern: ['backlog'],
    complexity: [2, 4],
  },
  // Several subjects, one question: investigate answers them side by side (parts), not backlog.
  {
    request:
      'Investigate how to improve the fix, refactor, review and analyze patterns: correctness, performance, token use and context drift.',
    pattern: ['investigate'],
    complexity: [3, 4],
  },
  // hangman is a demo game, never a route: a game request has no pattern of its own.
  { request: "Let's play a game of hangman.", pattern: ['new'], complexity: [1, 4] },
];

/** Compose-only maestro tasks, judged in code. Not in the default eval: `--task routing`. */
export const ROUTING_TASKS: readonly EvalTask[] = ROUTES.map((route, i) => ({
  id: `maestro-route-${String(i + 1).padStart(2, '0')}`,
  pattern: 'maestro',
  inputs: { request: route.request },
  files: {
    'package.json': PKG,
    '.gitignore': IGNORE,
    'README.md': '# fixture\n',
    'src/sum.js':
      'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n',
  },
  check: async ({ outcome, state }) => routedAs(outcome, state, route),
}));
