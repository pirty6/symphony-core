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

const PKG = '{ "name": "fixture", "type": "module", "scripts": { "test": "node --test" } }\n';
const IGNORE = '.symphony/\nnode_modules/\n';
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
    check: async ({ state }) =>
      mentions(String(state.answer ?? ''), ['8081', 'src/config.js', 'loadConfig']),
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
    check: async ({ state }) =>
      mentions(String(state.answer ?? ''), ['45', 'src/client.js', 'src/overrides.js']),
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
    check: async ({ state }) => {
      const answer = String(state.answer ?? '');
      const denies = /\b(no|not|never|doesn't|does not|without)\b[^.]{0,60}\bretr/i.test(answer);
      const invents = /retr\w*[^.]{0,40}\b(three|3) times\b[^.]{0,40}\bbecause\b/i.test(answer);
      return {
        pass: denies && !invents,
        notes: [
          denies ? 'says there is no retry' : 'does not say there is no retry',
          ...(invents ? ['explains a retry that does not exist'] : []),
        ],
      };
    },
  },
];
