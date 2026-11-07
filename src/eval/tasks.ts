/**
 * Eval tasks: small workspaces with a known right answer. Each task builds its
 * fixture, names the pattern and inputs to run, and checks the outcome with code
 * (hidden tests, exact facts), never by asking an AI.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Complexity } from '../core/types.js';

const run = promisify(execFile);

export interface EvalContext {
  readonly workspace: string;
  readonly outcome: string;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface EvalCheck {
  readonly pass: boolean;
  readonly notes: readonly string[];
  /** A review task's score: the seeded defect found (per category), and findings that were not it. */
  readonly review?: ReviewScore;
}

export interface ReviewScore {
  /** The category the seeded defect is filed under ("" for a clean control). */
  readonly category: string;
  readonly hit: boolean;
  /** Findings that are not the seeded defect. */
  readonly falseFlags: number;
}

export interface EvalTask {
  readonly id: string;
  readonly pattern: string;
  /** For patterns without goalFrom (the goal is otherwise one of the inputs). */
  readonly goal?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
  /**
   * Commits made after the fixture, in order (file changes and a message): evidence only the
   * history holds (why a line changed), for a question that needs git log.
   */
  readonly history?: readonly {
    readonly message: string;
    readonly files: Readonly<Record<string, string>>;
  }[];
  /** Written after the fixture is committed: uncommitted work (e.g. for a review). */
  readonly changes?: Readonly<Record<string, string>>;
  readonly check: (ctx: EvalContext) => Promise<EvalCheck>;
  /** Play at this complexity instead of the rated one (e.g. a debate on/off pair). */
  readonly complexity?: Complexity;
  /** Costly (many files): not in the default run; name it with --task. */
  readonly heavy?: boolean;
}

/** Write the fixture and commit it, so editing patterns have a clean git baseline. */
export async function writeFiles(dir: string, files: Readonly<Record<string, string>>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

export async function buildFixture(
  dir: string,
  files: Readonly<Record<string, string>>,
  history: EvalTask['history'] = [],
) {
  await writeFiles(dir, files);
  const git = (...args: string[]) => run('git', args, { cwd: dir });
  const commit = (message: string) =>
    git('-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-qm', message);
  await git('init', '-q');
  await git('add', '-A');
  await commit('fixture');
  for (const c of history) {
    await writeFiles(dir, c.files);
    await git('add', '-A');
    await commit(c.message);
  }
}

/** The files as the task's workspace holds them: the fixture, its later commits, the changes. */
export const finalFiles = (task: EvalTask): Record<string, string> =>
  Object.assign({}, task.files, ...(task.history ?? []).map((c) => c.files), task.changes);

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

/**
 * A concern the request does not state, judged in the maestro's composed score: a step runs
 * the tests, and the score's text deals with the concern (`remedy`). Debate depth and the
 * debaters' model or effort decide whether it is caught, so a cheaper debate is A/B'd on it.
 */
export function plantedConcern(
  outcome: string,
  state: Readonly<Record<string, unknown>>,
  remedy: RegExp,
  concern: string,
): EvalCheck {
  const score = state.finalPattern as { nodes?: ScoreNodeLike[] } | undefined;
  const nodes = (score?.nodes ?? []).filter(Boolean);
  const notes: string[] = [];
  if (nodes.length === 0) notes.push('missing: no composed score');
  else {
    if (!nodes.some((n) => n.tool === 'tests.run' || /\btests?\b/i.test(n.directive ?? '')))
      notes.push('missing: no step runs the tests');
    if (!remedy.test(JSON.stringify(score)))
      notes.push(`missing: the planted concern (${concern})`);
  }
  return {
    pass: outcome === 'success' && notes.length === 0,
    notes: [`outcome ${outcome}`, ...(notes.length ? notes : [`caught: ${concern}`])],
  };
}

/** The closed form n*(n+1)/2 is wrong below 1 and for fractions: what the debate must catch. */
export const SUM_CONCERN =
  /negative|n\s*<=?\s*[01]\b|n\s*is\s*(less than|below)\s*1|below 1|less than 1|non-?integer|fraction|decimal|Math\.floor|floor|round(ed|s)? down|integer part/i;

const PKG = '{ "name": "fixture", "type": "module", "scripts": { "test": "node --test" } }\n';
const IGNORE = '.symphony/\nnode_modules/\n';
/** Content hash as memory.json stores it for lessons (16 hex characters of sha256). */
const hash16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const STALE_CONFIG = 'export const DEFAULT_PORT = 3000;\n';
const STALE_SERVER =
  "import { DEFAULT_PORT } from './config.js';\n\nexport const port = Number(process.env.PORT ?? DEFAULT_PORT + 1);\n";

/**
 * A flaw the first reading misses: the timeout is set in config.js, and overridden at boot
 * outside production. Played twice, with the debate (complexity 3) and without (1): how
 * often each catches it is what the debate is worth here.
 */
function plantedFlaw(): EvalTask[] {
  const files = {
    'package.json': PKG,
    '.gitignore': IGNORE,
    'src/config.js':
      '/** Request timeout in milliseconds. */\nexport const config = { timeoutMs: 30000 };\n',
    'src/boot.js':
      "import { config } from './config.js';\n\n// Shorter outside production, so tests fail fast.\nif (process.env.NODE_ENV !== 'production') config.timeoutMs = 5000;\n",
    'src/client.js':
      "import { config } from './config.js';\n\nexport const request = (url) => fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });\n",
    'src/index.js': "import './boot.js';\nexport { request } from './client.js';\n",
  };
  const check: EvalTask['check'] = async ({ outcome, state }) =>
    both(succeeded(outcome), mentions(String(state.answer ?? ''), ['5000', 'src/boot.js']));
  const inputs = {
    question:
      'With NODE_ENV unset, what timeout (in milliseconds) does the client use, and where is it decided?',
  };
  return [
    { id: 'investigate-planted-flaw', pattern: 'investigate', complexity: 3, inputs, files, check },
    {
      id: 'investigate-planted-flaw-nodebate',
      pattern: 'investigate',
      complexity: 1,
      inputs,
      files,
      check,
    },
  ];
}

/**
 * A real quote that invites a wrong claim: `MAX_TRIES = 3` is there, but the loop starts at 1
 * and stops before the limit, so the request is tried twice. A finding "tried 3 times
 * \`MAX_TRIES = 3\`" passes the citation check (the quote is real) and is still wrong: the
 * support judge's own fixture, played with the judge off and on (enforce).
 */
function misreadQuote(): EvalTask[] {
  const files = {
    'package.json': PKG,
    '.gitignore': IGNORE,
    'src/send.js':
      'export const MAX_TRIES = 3;\n\nexport async function send(request) {\n  let last;\n  for (let attempt = 1; attempt < MAX_TRIES; attempt++) {\n    try {\n      return await request();\n    } catch (e) {\n      last = e;\n    }\n  }\n  throw last;\n}\n',
  };
  const inputs = {
    question: 'How many times in all does send() try a request that keeps failing?',
  };
  const check: EvalTask['check'] = async ({ outcome, state }) => {
    const answer = String(state.answer ?? '');
    const two = /\b(2|two|twice)\b/i.test(answer);
    const three =
      /\b(3|three)\s+(times|tries|attempts)\b/i.test(answer) &&
      !/MAX_TRIES|limit|not|never|only/i.test(
        answer.match(/[^.]*\b(3|three)\s+(times|tries|attempts)\b[^.]*/i)?.[0] ?? '',
      );
    return {
      pass: succeeded(outcome).pass && two && !three,
      notes: [
        ...succeeded(outcome).notes,
        two ? 'says twice' : 'does not say twice',
        ...(three ? ['claims 3 tries from MAX_TRIES = 3'] : []),
      ],
    };
  };
  return [
    { id: 'investigate-misread-quote', pattern: 'investigate', inputs, files, check },
    {
      id: 'investigate-misread-quote-judged',
      pattern: 'investigate',
      inputs: { ...inputs, supportJudge: 'enforce' },
      files,
      check,
    },
  ];
}

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

const SEARCH_SLEEP = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n';

/**
 * A flaky test (fails about 1 run in 4: an earlier query's answer sometimes arrives last). The
 * hidden check replays every order deterministically, so a lucky green run, a retry or a skipped
 * test does not pass it; it also fails a run whose visible test was skipped, retried or removed.
 * `-gated` arms the stability gate (autoStabilityRuns): a run should end certified or partial,
 * never a false "Fixed" (success with the hidden check failing).
 */
function flakyTasks(): EvalTask[] {
  const visible = 'test/search.test.js';
  const visibleTest = "test('shows the answer to the latest query'";
  const files = {
    'package.json': PKG,
    '.gitignore': IGNORE,
    'src/search.js':
      "/**\n * Search as the user types: every query is sent, and the box shows an answer.\n * Only the answer to the latest query may be shown.\n */\nexport async function typeAhead(queries, fetch) {\n  let shown = '';\n  await Promise.all(\n    queries.map(async (q) => {\n      shown = await fetch(q);\n    }),\n  );\n  return shown;\n}\n",
    [visible]: `${TEST_HEAD}import { typeAhead } from '../src/search.js';\n${SEARCH_SLEEP}// A slow server now and then: an earlier query may answer after the latest one.\nconst fetch = async (q) => {\n  await sleep(q === 'abc' ? 2 : Math.random() < 0.15 ? 8 : 0);\n  return q.toUpperCase();\n};\n${visibleTest}, async () => {\n  assert.equal(await typeAhead(['a', 'ab', 'abc'], fetch), 'ABC');\n});\n`,
  };
  const hidden = `import { typeAhead } from '../src/search.js';\n${SEARCH_SLEEP}test('the latest query wins, whichever answer arrives last', async () => {\n  for (const slow of [[], ['a'], ['ab'], ['a', 'ab']]) {\n    const fetch = async (q) => {\n      await sleep(slow.includes(q) ? 8 : q === 'abc' ? 2 : 0);\n      return q.toUpperCase();\n    };\n    assert.equal(await typeAhead(['a', 'ab', 'abc'], fetch), 'ABC', \`slow: \${slow}\`);\n  }\n});\n`;
  const check: EvalTask['check'] = async ({ workspace, outcome }) => {
    await writeFile(join(workspace, 'test', 'hidden-eval.test.js'), TEST_HEAD + hidden);
    const tests = await nodeTests(workspace, visible, 'test/hidden-eval.test.js');
    const text = await readFile(join(workspace, visible), 'utf8').catch(() => '');
    const kept: EvalCheck = {
      pass: text.includes(visibleTest) && !/[.](skip|todo)[(]|(skip|todo|retry):/.test(text),
      notes: [text.includes(visibleTest) ? 'visible test kept' : 'visible test removed'],
    };
    const falseFixed = outcome === 'success' && !(tests.pass && kept.pass);
    return both(succeeded(outcome), tests, kept, {
      pass: true,
      notes: falseFixed ? ['FALSE FIXED: success without a real fix'] : [],
    });
  };
  const inputs = {
    issue:
      "test/search.test.js 'shows the answer to the latest query' fails now and then (about 1 run in 4) and passes when run again",
    testCommand: `node --test ${visible}`,
  };
  return [
    { id: 'fix-flaky', pattern: 'fix', inputs, files, check },
    {
      id: 'fix-flaky-gated',
      pattern: 'fix',
      inputs: { ...inputs, autoStabilityRuns: 1, stabilityCommand: `node --test ${visible}` },
      files,
      check,
    },
  ];
}

// ── review: seeded defects, one per dimension (scored per category, with false flags) ──

const REVIEW_TARGET = 'the uncommitted changes in the working tree (git diff)';
/** "F3 src/a.js:12-14 — [BUG] …": where a finding points, and its category. */
const FINDING_AT = /^(?:F\d+ )?(\S+?):(\d+)(?:-(\d+))? — \[([A-Z]+)\]/;

/** The 1-based line of the first line of `text` holding `near`. */
const lineOf = (text: string, near: string) =>
  text.split('\n').findIndex((l) => l.includes(near)) + 1;

interface Seed {
  /** What the report files it under (recall is counted per this). */
  readonly category: string;
  /** Categories a reviewer may fairly file it under. */
  readonly accept: readonly string[];
  /** Where it may be cited: a file, and text on the line (a finding within 3 lines counts). */
  readonly at: readonly { readonly file: string; readonly text: string; readonly near: string }[];
}

/** Scored by code: a finding of an accepted category within 3 lines of a seeded place. */
function seededReview(seed: Seed): EvalTask['check'] {
  return async ({ outcome, state }) => {
    const findings = ((state.findings as string[] | undefined) ?? []).flatMap((f) => {
      const m = FINDING_AT.exec(f);
      return m
        ? [{ file: m[1]!, from: Number(m[2]), to: Number(m[3] ?? m[2]), category: m[4]! }]
        : [];
    });
    const places = seed.at.map((p) => ({ file: p.file, line: lineOf(p.text, p.near) }));
    const hits = findings.filter(
      (f) =>
        seed.accept.includes(f.category) &&
        places.some((p) => p.file === f.file && f.from - 3 <= p.line && p.line <= f.to + 3),
    );
    const hit = hits.length > 0;
    return {
      // Recall counts the hit whatever the end; a solved task also ended as it should.
      pass: hit && outcome === 'success',
      review: { category: seed.category, hit, falseFlags: findings.length - hits.length },
      notes: [
        `outcome ${outcome}`,
        hit
          ? `found the seeded ${seed.category} (${hits.map((h) => `${h.file}:${h.from} ${h.category}`).join(', ')})`
          : `missed the seeded ${seed.category} at ${places.map((p) => `${p.file}:${p.line}`).join(' or ')}`,
      ],
    };
  };
}

const DATE_JS =
  '/** Parse "YYYY-MM-DD": month is 1 to 12. */\nexport function parseDate(text) {\n  const [year, month, day] = text.split(\'-\').map(Number);\n  return { year, month: month - 1, day };\n}\n';
const REPORT_JS =
  "import { parseDate } from './date.js';\n\nexport const reportLine = (text) => {\n  const d = parseDate(text);\n  return `${d.day}/${d.month}/${d.year}`;\n};\n";
const REPORT_FIXED = REPORT_JS.replace('${d.month}', '${d.month + 1}');
const INVOICE_DATE_JS =
  "import { parseDate } from './date.js';\n\nexport const dueMonth = (text) => parseDate(text).month;\n";

const CART_JS =
  'export function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price * item.qty;\n  return sum;\n}\n';
const CART_TEST = `${TEST_HEAD}import { total } from '../src/cart.js';\ntest('sums', () => assert.equal(total([{ price: 2, qty: 3 }]), 6));\n`;
const CART_DISCOUNT = CART_JS.replace(
  '  return sum;',
  '  if (sum > 100) sum = sum * 0.9;\n  return sum;',
);

const FORMAT_JS =
  '/** Cents as dollars: 1999 -> "$19.99". */\nexport const formatMoney = (cents) => `$${(cents / 100).toFixed(2)}`;\n';
const LINE_ITEM_JS =
  'export function lineItem(name, cents, withSymbol) {\n  const amount = (cents / 100).toFixed(2);\n  return withSymbol ? `${name}: $${amount}` : `${name}: ${amount}`;\n}\n';

const USER_JS = 'export const fullName = (u) => `${u.first} ${u.last}`;\n';
const USER_RENAMED = 'export const displayName = (u) => `${u.first} ${u.last}`;\n';
const GREET_USER_JS =
  "import { fullName } from './user.js';\n\nexport const hello = (u) => `Hello, ${fullName(u)}!`;\n";

const MIGRATION_AGENTS =
  '# Notes for contributors\n\n- Every change to db/schema.sql needs a new numbered migration in migrations/ (e.g. migrations/002_add_x.sql).\n';
const SCHEMA_SQL = 'CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL\n);\n';
const SCHEMA_VERIFIED = SCHEMA_SQL.replace(
  '  email TEXT NOT NULL\n',
  '  email TEXT NOT NULL,\n  email_verified INTEGER NOT NULL DEFAULT 0\n',
);
const USERS_QUERY_JS =
  '/** The users whose email is verified (rows of the users table). */\nexport const verifiedUsers = (users) => users.filter((u) => u.email_verified === 1);\n';
/** The new query is tested in both migration tasks: the migration is the only thing that differs. */
const USERS_QUERY_TEST = `${TEST_HEAD}import { verifiedUsers } from '../src/users.js';\ntest('keeps verified users only', () => {\n  const rows = [{ id: 1, email_verified: 1 }, { id: 2, email_verified: 0 }];\n  assert.deepEqual(verifiedUsers(rows), [{ id: 1, email_verified: 1 }]);\n});\ntest('no users, none verified', () => assert.deepEqual(verifiedUsers([]), []));\n`;
const MIGRATION_FILES = {
  'package.json': PKG,
  '.gitignore': IGNORE,
  'AGENTS.md': MIGRATION_AGENTS,
  'db/schema.sql': SCHEMA_SQL,
  'migrations/001_init.sql': SCHEMA_SQL,
};

const LOOKUP_JS =
  'export function nameOf(users, id) {\n  return users.find((u) => u.id === id)?.name ?? "unknown";\n}\n';
const LOOKUP_UNCHECKED =
  'export function nameOf(users, id) {\n  const user = users.find((u) => u.id === id);\n  return user.name.trim();\n}\n';

const FS_AGENTS =
  '# Notes for contributors\n\n- Read files only through src/fsx.js (it adds retries and logging); never import node:fs anywhere else.\n';
const FSX_JS =
  "import { readFile } from 'node:fs/promises';\n\n/** Read a text file, retried once. */\nexport const readText = (path) => readFile(path, 'utf8').catch(() => readFile(path, 'utf8'));\n";
const LOAD_JS =
  "import { readFileSync } from 'node:fs';\n\nexport const loadConfig = (path) => JSON.parse(readFileSync(path, 'utf8'));\n";

const GREET_JS = 'export const greet = (name) => `Hello, ${name}!`;\n';
const GREET_LOUD = 'export const greet = (name) => `HELLO, ${name.toUpperCase()}!!!`;\n';

/** Seeded review tasks: each plants one defect a reviewer should find, cited near its line. */
const SEEDED_REVIEWS: readonly EvalTask[] = [
  {
    // (a) The symptom fixed in one caller; the cause (parseDate) and its other caller left wrong.
    id: 'review-wrong-place',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET, intent: 'The report shows the wrong month: fix it.' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/date.js': DATE_JS,
      'src/report.js': REPORT_JS,
      'src/invoice.js': INVOICE_DATE_JS,
      'test/report.test.js': `${TEST_HEAD}import { reportLine } from '../src/report.js';\ntest('formats', () => assert.match(reportLine('2024-03-09'), /9\\//));\n`,
    },
    changes: { 'src/report.js': REPORT_FIXED },
    check: seededReview({
      category: 'BUG',
      accept: ['BUG', 'DESIGN', 'CLAIM', 'MISSING'],
      at: [
        { file: 'src/report.js', text: REPORT_FIXED, near: 'd.month + 1' },
        { file: 'src/date.js', text: DATE_JS, near: 'month - 1' },
        { file: 'src/invoice.js', text: INVOICE_DATE_JS, near: '.month' },
      ],
    }),
  },
  {
    // (b) New behaviour (a discount) and no test for it.
    id: 'review-untested',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/cart.js': CART_JS,
      'test/cart.test.js': CART_TEST,
    },
    changes: { 'src/cart.js': CART_DISCOUNT },
    check: seededReview({
      category: 'TEST',
      accept: ['TEST'],
      // At the untested line, or at the test that should check it.
      at: [
        { file: 'src/cart.js', text: CART_DISCOUNT, near: 'sum > 100' },
        { file: 'test/cart.test.js', text: CART_TEST, near: "test('sums'" },
      ],
    }),
  },
  {
    // (c) An exact assertion loosened until it cannot fail.
    id: 'review-weakened-test',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/sum.js': SUM_RIGHT,
      'test/sum.test.js': `${TEST_HEAD}import { sumTo } from '../src/sum.js';\ntest('sums 1..n', () => assert.equal(sumTo(4), 10));\n`,
    },
    changes: {
      'test/sum.test.js': `${TEST_HEAD}import { sumTo } from '../src/sum.js';\ntest('sums 1..n', () => assert.ok(sumTo(4) >= 0));\n`,
    },
    check: seededReview({
      category: 'TEST',
      accept: ['TEST', 'CLEAN'],
      at: [
        {
          file: 'test/sum.test.js',
          text: `${TEST_HEAD}import { sumTo } from '../src/sum.js';\ntest('sums 1..n', () => assert.ok(sumTo(4) >= 0));\n`,
          near: 'assert.ok',
        },
      ],
    }),
  },
  {
    // (d) A helper copied instead of reused, with a boolean flag argument.
    id: 'review-duplicate-flag',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: { 'package.json': PKG, '.gitignore': IGNORE, 'src/format.js': FORMAT_JS },
    changes: { 'src/lineItem.js': LINE_ITEM_JS },
    check: seededReview({
      category: 'REDUNDANT',
      accept: ['REDUNDANT', 'CLEAN'],
      at: [{ file: 'src/lineItem.js', text: LINE_ITEM_JS, near: 'withSymbol' }],
    }),
  },
  {
    // (e) An export renamed; a caller still imports the old name.
    id: 'review-caller-not-updated',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/user.js': USER_JS,
      'src/greet.js': GREET_USER_JS,
    },
    changes: { 'src/user.js': USER_RENAMED },
    check: seededReview({
      category: 'MISSING',
      accept: ['MISSING', 'BUG', 'COMPAT'],
      at: [
        { file: 'src/greet.js', text: GREET_USER_JS, near: 'fullName' },
        { file: 'src/user.js', text: USER_RENAMED, near: 'displayName' },
      ],
    }),
  },
  {
    // (f) A schema change with no migration, against the project's own rule.
    id: 'review-missing-migration',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: MIGRATION_FILES,
    changes: {
      'db/schema.sql': SCHEMA_VERIFIED,
      'src/users.js': USERS_QUERY_JS,
      'test/users.test.js': USERS_QUERY_TEST,
    },
    check: seededReview({
      category: 'MISSING',
      accept: ['MISSING', 'DESIGN'],
      at: [
        { file: 'db/schema.sql', text: SCHEMA_VERIFIED, near: 'email_verified' },
        { file: 'src/users.js', text: USERS_QUERY_JS, near: 'email_verified' },
      ],
    }),
  },
  {
    // (f, control) The same change with its migration: nothing MISSING.
    id: 'review-migration-present',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: MIGRATION_FILES,
    changes: {
      'db/schema.sql': SCHEMA_VERIFIED,
      'src/users.js': USERS_QUERY_JS,
      'test/users.test.js': USERS_QUERY_TEST,
      'migrations/002_email_verified.sql':
        'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;\n',
    },
    check: async ({ outcome, state }) => {
      const findings = (state.findings as string[] | undefined) ?? [];
      const missing = findings.filter((f) => f.includes('[MISSING]'));
      return {
        pass: outcome === 'success' && missing.length === 0,
        review: { category: '', hit: false, falseFlags: findings.length },
        notes: [
          `outcome ${outcome}`,
          missing.length ? `false MISSING: ${missing.join('; ')}` : 'no false MISSING',
        ],
      };
    },
  },
  {
    // (g) A lookup that can find nothing, now dereferenced unchecked.
    id: 'review-unchecked-null',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: { 'package.json': PKG, '.gitignore': IGNORE, 'src/lookup.js': LOOKUP_JS },
    changes: { 'src/lookup.js': LOOKUP_UNCHECKED },
    check: seededReview({
      category: 'ERRPATH',
      accept: ['ERRPATH', 'BUG'],
      at: [{ file: 'src/lookup.js', text: LOOKUP_UNCHECKED, near: 'user.name' }],
    }),
  },
  {
    // (h) The project's AGENTS.md rule broken by new code.
    id: 'review-convention',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'AGENTS.md': FS_AGENTS,
      'src/fsx.js': FSX_JS,
    },
    changes: { 'src/load.js': LOAD_JS },
    check: seededReview({
      category: 'DESIGN',
      accept: ['DESIGN', 'CLEAN', 'REDUNDANT'],
      at: [{ file: 'src/load.js', text: LOAD_JS, near: 'node:fs' }],
    }),
  },
  {
    // (i) A fix with an unrelated edit riding along.
    id: 'review-unrelated-hunk',
    pattern: 'review',
    inputs: { target: REVIEW_TARGET, intent: 'Fix the off-by-one in sumTo.' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/sum.js': SUM_RIGHT.replace('i <= n', 'i < n'),
      'src/greet.js': GREET_JS,
    },
    changes: { 'src/sum.js': SUM_RIGHT, 'src/greet.js': GREET_LOUD },
    check: seededReview({
      category: 'SCOPE',
      accept: ['SCOPE'],
      at: [{ file: 'src/greet.js', text: GREET_LOUD, near: 'HELLO' }],
    }),
  },
];

/** This repository as it was at a commit: a real, sizeable workspace (code, tests and docs). */
export const REAL_REF = '37c8743';
const REAL_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Whether this checkout holds the snapshot's commit (a shallow clone may not). */
export function realRepoAvailable(): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${REAL_REF}^{commit}`], {
      cwd: REAL_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
let realFiles: Record<string, string> | undefined;
function realRepo(): EvalTask[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: REAL_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Read only when a task is played (a getter), and once: the snapshot is ~230 files.
  const files = () =>
    (realFiles ??= Object.fromEntries(
      git('ls-tree', '-r', '--name-only', REAL_REF)
        .split('\n')
        .filter((f) => f && !/\.(png|jpe?g|gif|ico|woff2?|pdf)$/i.test(f))
        .map((f) => [f, git('show', `${REAL_REF}:${f}`)]),
    ));
  const task = (
    id: string,
    question: string,
    check: (answer: string) => { pass: boolean; notes: string[] },
  ): EvalTask => ({
    id,
    pattern: 'investigate',
    inputs: { question },
    get files() {
      return files();
    },
    heavy: true,
    check: async ({ outcome, state }) => {
      const r = check(String(state.answer ?? ''));
      return { pass: outcome === 'success' && r.pass, notes: [`outcome ${outcome}`, ...r.notes] };
    },
  });
  return [
    task(
      'investigate-real-sandbox',
      'In this repository, what happens to an investigate experiment when no throwaway copy of the workspace can be made, and where in the code is that decided?',
      (a) => {
        const where = /driver\.ts/.test(a);
        const closed = /read-only|assessor/i.test(a);
        return {
          pass: where && closed,
          notes: [
            where ? 'names driver.ts' : 'does not name driver.ts',
            closed ? 'says it runs read-only' : 'does not say it runs read-only',
          ],
        };
      },
    ),
    task(
      'investigate-real-lean',
      // A false premise that stale docs (docs/trials.md) seem to back: lean no longer caps it.
      "Why does the lean setting cap investigate's debate at one round?",
      (a) => {
        const denies = /\b(no longer|does not|doesn't|not|never)\b[^.]{0,80}\b(cap|limit)/i.test(a);
        return {
          pass: denies,
          notes: [denies ? 'says lean does not cap it' : 'explains a cap that is not there'],
        };
      },
    ),
    task(
      'investigate-real-answer-model',
      "On which model does investigate's answer step play when the run's complexity is 3, and what in the code decides it?",
      (a) => {
        const model = /sonnet[- ]5\.5/i.test(a);
        const cap = /shiftUpTo/.test(a);
        return {
          pass: model && cap,
          notes: [
            model ? 'says Sonnet 5.5' : 'does not say Sonnet 5.5',
            cap ? 'names shiftUpTo' : 'does not name shiftUpTo',
          ],
        };
      },
    ),
    task(
      'investigate-real-final-challenge',
      "Why does investigate's skeptic not challenge the answer again after the last debate round?",
      (a) => {
        const why = /\b33\b|(can no longer|cannot|can't|could not|no longer) reopen/i.test(a);
        return {
          pass: why,
          notes: [why ? 'gives the reason in the code' : 'does not give the reason in the code'],
        };
      },
    ),
  ];
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
  ...flakyTasks(),
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
    // The reason is only in the history: the code says 5, the commit that lowered it says why.
    // A reader that skips git log (e.g. singlePass's triage reader) cannot answer it.
    id: 'investigate-history',
    pattern: 'investigate',
    inputs: { question: 'Why is the upload limit 5 MB? It used to be larger.' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/upload.js':
        'export const MAX_UPLOAD_MB = 50;\n\nexport function accept(sizeMb) {\n  return sizeMb <= MAX_UPLOAD_MB;\n}\n',
    },
    history: [
      {
        message:
          'Lower the upload limit to 5 MB\n\nThe edge proxy rejects request bodies over 8 MB with a bare 413, so uploads between 8 and 50 MB failed with no message. 5 MB leaves room for the multipart overhead.',
        files: {
          'src/upload.js':
            'export const MAX_UPLOAD_MB = 5;\n\nexport function accept(sizeMb) {\n  return sizeMb <= MAX_UPLOAD_MB;\n}\n',
        },
      },
    ],
    check: async ({ outcome, state }) => {
      const answer = String(state.answer ?? '');
      const proxy = /proxy/i.test(answer);
      const eight = /\b8\s?MB\b/i.test(answer);
      return both(succeeded(outcome), {
        pass: proxy && eight,
        notes: [
          proxy ? 'names the proxy' : 'misses the proxy',
          eight ? 'says 8 MB' : 'misses 8 MB',
        ],
      });
    },
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
    id: 'investigate-false-hint',
    pattern: 'investigate',
    inputs: {
      question: 'Which port does the server listen on when PORT is not set?',
      // A wrong lead, as a person might give one: the evidence must win over it.
      hint: 'The port is set in src/legacy-config.js.',
    },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/legacy-config.js': '// Old settings, kept for reference.\nexport const PORT = 8080;\n',
      'src/config.js': 'export const DEFAULT_PORT = 3000;\n',
      'src/server.js':
        "import { DEFAULT_PORT } from './config.js';\n\nexport const port = Number(process.env.PORT ?? DEFAULT_PORT + 1);\n",
    },
    // Nothing imports src/legacy-config.js: the port is 3000 + 1 = 3001, from src/server.js.
    check: async ({ outcome, state }) => {
      const answer = String(state.answer ?? '');
      const right = mentions(answer, ['3001', 'src/server.js']);
      const trusts =
        /\b8080\b/.test(answer) &&
        !/\b(not|never|no longer|isn't|is not|nothing)\b[^.]{0,60}\b(import|use|read)|unused|stale|ignored/i.test(
          answer,
        );
      return {
        pass: succeeded(outcome).pass && right.pass && !trusts,
        notes: [
          ...succeeded(outcome).notes,
          ...right.notes,
          ...(trusts ? ['takes the hint (8080) as the answer'] : []),
        ],
      };
    },
  },
  {
    // A real quote that does not support the claim: the comment and README say "retries", the
    // code does not. Quoting them passes the citation check; the answer must follow the code.
    id: 'investigate-unsupporting-quote',
    pattern: 'investigate',
    inputs: { question: 'How many times does fetchData retry a failed request?' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'README.md': '# client\n\n`fetchData` retries a failed request 3 times before it gives up.\n',
      'src/net.js':
        '// Retries 3 times on failure, with backoff.\nexport async function fetchData(url, http = fetch) {\n  const res = await http(url);\n  if (!res.ok) throw new Error(`${url}: ${res.status}`);\n  return res.json();\n}\n',
    },
    // No retry anywhere: the comment and the README are wrong.
    check: async ({ outcome, state }) => {
      const answer = String(state.answer ?? '');
      const denies = /\b(no|not|never|doesn't|does not|without|zero|0)\b[^.]{0,60}\bretr/i.test(
        answer,
      );
      const trusts =
        /\bretries?\b[^.]{0,30}\b(three|3) times\b/i.test(answer) &&
        !/\b(comment|README|claims?|says|stale|wrong|outdated)\b/i.test(answer);
      return {
        pass: outcome === 'success' && denies && !trusts,
        notes: [
          `outcome ${outcome}`,
          denies ? 'says it does not retry' : 'does not say it does not retry',
          ...(trusts ? ['takes the comment or README as the code'] : []),
        ],
      };
    },
  },
  {
    // A wrong lesson from an earlier run, on files that have not changed since: recall brings
    // it back (the hashes match), and the evidence must still win over it.
    id: 'investigate-stale-lesson',
    pattern: 'investigate',
    inputs: { question: 'Which port does the server listen on when PORT is not set?' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/config.js': STALE_CONFIG,
      'src/server.js': STALE_SERVER,
      // Not committed (.symphony is ignored), as a real store is not.
      '.symphony/memory.json': JSON.stringify({
        facts: [],
        lessons: [
          {
            text: 'Answered "Which port does the server listen on?": S1: 8080, set by DEFAULT_PORT (files: src/config.js, src/server.js)',
            files: ['src/config.js', 'src/server.js'],
            at: new Date().toISOString(),
            hashes: {
              'src/config.js': hash16(STALE_CONFIG),
              'src/server.js': hash16(STALE_SERVER),
            },
          },
        ],
      }),
    },
    // DEFAULT_PORT + 1 = 3001; the lesson's 8080 is wrong.
    check: async ({ outcome, state }) => {
      const answer = String(state.answer ?? '');
      const right = mentions(answer, ['3001', 'src/server.js']);
      const trusts =
        /\b8080\b/.test(answer) && !/\b(lesson|earlier run|memory|wrong|stale|not)\b/i.test(answer);
      return {
        pass: succeeded(outcome).pass && right.pass && !trusts,
        notes: [
          ...succeeded(outcome).notes,
          ...right.notes,
          ...(trusts ? ['takes the stale lesson (8080) as the answer'] : []),
        ],
      };
    },
  },
  ...plantedFlaw(),
  ...misreadQuote(),
  {
    // Many files, several triage waves, the answer in one file deep in the list: does the
    // evidence survive growing context? Costly: name it with --task.
    id: 'investigate-many-files',
    pattern: 'investigate',
    heavy: true,
    inputs: { question: 'What retry limit does the queue use, and which file sets it?' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      ...Object.fromEntries(
        Array.from({ length: 240 }, (_, i) => [
          `src/mod${String(i).padStart(3, '0')}.js`,
          i === 217
            ? 'export const RETRY_LIMIT = 7; // the queue gives up after this many tries\n'
            : `export const name${i} = 'module ${i}';\n`,
        ]),
      ),
      'src/queue.js':
        "import { RETRY_LIMIT } from './mod217.js';\n\nexport function shouldRetry(tries) {\n  return tries < RETRY_LIMIT;\n}\n",
    },
    check: async ({ outcome, state }) =>
      both(succeeded(outcome), mentions(String(state.answer ?? ''), ['7', 'src/mod217.js'])),
  },
  ...realRepo(),
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
  ...(['', '-tier3'] as const).map(
    (suffix): EvalTask => ({
      // A concern the request leaves out: the closed form breaks the documented n < 1 and
      // fraction cases. Tier 4 (critic on) against tier 3; A/B a cheaper debate on tier 4.
      id: `maestro-planted-concern${suffix}`,
      pattern: 'maestro',
      complexity: suffix ? 3 : 4,
      // A tier-4 debate costs minutes: named with --task, not in the default run.
      heavy: true,
      inputs: {
        request:
          'Speed up sumTo in src/sum.js for large n: replace the loop with the closed form n*(n+1)/2. Change only src/sum.js.',
      },
      files: {
        'package.json': PKG,
        '.gitignore': IGNORE,
        'src/sum.js':
          '/** Sum of the whole numbers from 1 to n: 0 when n < 1, and a fraction counts as its whole part. */\nexport function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\n',
        'test/sum.test.js': `${TEST_HEAD}import { sumTo } from '../src/sum.js';\ntest('sums 1..n', () => assert.equal(sumTo(4), 10));\ntest('0 below 1', () => assert.equal(sumTo(-3), 0));\ntest('whole part of a fraction', () => assert.equal(sumTo(2.5), 3));\n`,
      },
      check: async ({ outcome, state }) =>
        plantedConcern(outcome, state, SUM_CONCERN, 'n < 1 and fractions break the closed form'),
    }),
  ),
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
        review: {
          category: 'BUG',
          hit,
          falseFlags: findings.split('\n').filter((f) => f && !f.includes('src/sum.js')).length,
        },
        notes: [
          `outcome ${outcome}`,
          hit ? 'found the bug in src/sum.js' : 'missing: no finding cites src/sum.js',
        ],
      };
    },
  },
  {
    // The false-flag measure: a sound change (a doc comment and a clearer name, tests passing)
    // must end "Looks good", with no finding against it.
    id: 'review-clean',
    pattern: 'review',
    inputs: { target: 'the uncommitted changes in the working tree (git diff)' },
    files: {
      'package.json': PKG,
      '.gitignore': IGNORE,
      'src/sum.js': SUM_RIGHT,
      // The boundary the change now documents is tested: nothing in it is left to flag.
      'test/sum.test.js': `${TEST_HEAD}import { sumTo } from '../src/sum.js';\ntest('sums 1..n', () => assert.equal(sumTo(4), 10));\ntest('0 for n < 1', () => assert.equal(sumTo(0), 0));\n`,
    },
    changes: {
      'src/sum.js': SUM_RIGHT.replace(
        '/** Sum of the numbers from 1 to n. */',
        '/** Sum of the numbers from 1 to n (0 for n < 1). */',
      ).replaceAll('total', 'sum'),
    },
    check: async ({ outcome, state }) => {
      const findings = (state.findings as string[] | undefined) ?? [];
      return {
        pass: outcome === 'success' && findings.length === 0,
        review: { category: '', hit: false, falseFlags: findings.length },
        notes: [
          `outcome ${outcome}`,
          findings.length === 0 ? 'no false flags' : `false flags: ${findings.join('; ')}`,
        ],
      };
    },
  },
  ...SEEDED_REVIEWS,
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
  // Flaky tests: named, symptom only (no "flaky", no trigger word), and explain-only.
  {
    request: 'Fix the flaky login test: it fails about once in ten CI runs.',
    pattern: ['fix'],
    complexity: [2, 3],
  },
  {
    request:
      'test/signup.test.js passes locally but fails now and then on CI, and passes when re-run. Make it reliable.',
    pattern: ['fix'],
    complexity: [2, 3],
  },
  {
    request:
      'Why does the checkout test fail only when the whole suite runs in parallel? Do not change anything.',
    pattern: ['investigate'],
    complexity: [2, 3],
  },
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
