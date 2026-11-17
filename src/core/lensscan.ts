/**
 * The deterministic half of each pillar lens: what a rule can catch in a diff or a test file,
 * named by the rule it breaks. Leads for the lens's reviewer, except the test-body breaks, which
 * Symphony's own edits must not make. Pure: the diff and files come in as text.
 */
import { filesOf, scanDiff, TEST_FILE, type FileDiff } from './diffscan.js';
import type { PillarId } from './pillars.js';
import { scrubText } from './scrub.js';

export type LensLeads = Record<PillarId, string[]>;

const EACH = /\b(it|test|describe)\.each\b/;
const SLEEP = /\b(setTimeout|sleep|waitForTimeout)\s*\(|Thread\.Sleep|Task\.Delay|time\.sleep\(/;
const CLOCK = /\bDate\.now\(\)|\bnew Date\(\)|DateTime\.(Now|UtcNow)\b|datetime\.now\(/;
const RANDOM = /\bMath\.random\(\)|\brandom\.random\(\)/;
const EVAL = /\beval\s*\(|\bnew Function\s*\(|\bpickle\.loads?\(|\byaml\.load\(/;
const SHELL_INTERPOLATED =
  /\b(exec|execSync|spawn|spawnSync|execFile|system|popen)\s*\(\s*(`[^`]*\$\{|[^,)]*\+\s*\w)|\bshell\s*:\s*true\b|shell\s*=\s*True/;
const SQL_INTERPOLATED =
  /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*(\$\{|['"]\s*\+|\+\s*['"]|%s|\.format\()/i;
const HTML_SINK = /\.innerHTML\s*=|dangerouslySetInnerHTML|document\.write\(/;
const TLS_OFF = /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False/;
const SYNC_IO = /\b(readFileSync|writeFileSync|execSync|spawnSync|readdirSync)\s*\(/;
const DEEP_COPY = /JSON\.parse\(\s*JSON\.stringify\(/;
const INTERVAL = /\bsetInterval\s*\(/;
const LOOP_START = /\b(for|foreach|while)\s*\(|\.forEach\s*\(/;
const ASYNC_FOREACH = /\.forEach\s*\(\s*async\b/;
/** Added lines after a loop opens in which an `await` means one awaited call per item. */
const LOOP_REACH = 6;

const emptyLeads = (): LensLeads => ({
  CORRECTNESS: [],
  SECURITY: [],
  CLEAN: [],
  TESTS: [],
  PERFORMANCE: [],
  DETERMINISM: [],
});

const unquoted = (line: string): string => line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');

/** A line inside a block comment (` * …`), which holds no code. */
const BLOCK_COMMENT_LINE = /^\s*(\*|\/\*)/;

/** Source text without string literals or comments: what keywords and braces are. */
export const codeOnly = (line: string): string =>
  BLOCK_COMMENT_LINE.test(line)
    ? ''
    : unquoted(line)
        .replace(/\/\*.*?(\*\/|$)/g, '')
        .replace(/\/\/.*$/, '');

/** The same for Python, whose comments start with `#`. */
const pythonCodeOnly = (line: string): string => unquoted(line).replace(/#.*$/, '');

function securityLeads(f: FileDiff): string[] {
  const out: string[] = [];
  const isTest = TEST_FILE.test(f.path);
  for (const [line, text] of f.added) {
    const at = (hint: string) => out.push(`${f.path}:${line} — ${hint}`);
    if (scrubText(text) !== text) at('a credential in the change (SEC-2)');
    if (isTest) continue;
    const code = codeOnly(text);
    if (EVAL.test(code)) at('eval or unsafe deserialization (SEC-5)');
    if (SHELL_INTERPOLATED.test(text)) at('a shell command built from values (SEC-1)');
    if (SQL_INTERPOLATED.test(text)) at('a query built from values (SEC-1)');
    if (HTML_SINK.test(code)) at('HTML written from values (SEC-1)');
    if (TLS_OFF.test(code)) at('certificate checks turned off (SEC-6)');
    if (RANDOM.test(code)) at('Math.random: never for a token, id or nonce (SEC-7)');
  }
  return out;
}

function loopAwaitLeads(f: FileDiff): string[] {
  const out: string[] = [];
  f.added.forEach(([line, text], i) => {
    if (!LOOP_START.test(codeOnly(text))) return;
    const body = f.added.slice(i + 1, i + 1 + LOOP_REACH);
    const awaited = body.find(([at, t], j) => at === line + j + 1 && /\bawait\b/.test(codeOnly(t)));
    if (awaited)
      out.push(`${f.path}:${awaited[0]} — an await inside a loop: one call per item? (PERF-1)`);
  });
  return out;
}

function performanceLeads(f: FileDiff): string[] {
  if (TEST_FILE.test(f.path)) return [];
  const out = loopAwaitLeads(f);
  for (const [line, text] of f.added) {
    const code = codeOnly(text);
    const at = (hint: string) => out.push(`${f.path}:${line} — ${hint}`);
    if (SYNC_IO.test(code)) at('synchronous I/O: on a hot or request path? (PERF-4)');
    if (DEEP_COPY.test(code)) at('a deep copy through JSON: large data? (PERF-5)');
    if (INTERVAL.test(code)) at('setInterval: is it cleared? (PERF-3)');
  }
  return out;
}

function determinismLeads(f: FileDiff): string[] {
  if (TEST_FILE.test(f.path)) return [];
  const out: string[] = [];
  for (const [line, text] of f.added) {
    const code = codeOnly(text);
    const at = (hint: string) => out.push(`${f.path}:${line} — ${hint}`);
    if (CLOCK.test(code)) at('reads the clock: should the time come in as an input? (DET-3)');
    if (RANDOM.test(code)) at('a random number in logic: an input instead? (DET-3)');
    if (ASYNC_FOREACH.test(code)) at('async callbacks in forEach are not awaited (DET-1)');
  }
  return out;
}

function testDiffLeads(f: FileDiff): string[] {
  if (!TEST_FILE.test(f.path)) return [];
  return f.added
    .filter(([, text]) => EACH.test(codeOnly(text)))
    .map(
      ([line]) => `${f.path}:${line} — test.each: write each case as its own named test (UT-3.2)`,
    );
}

/** Per pillar, the leads a deterministic scan finds in the added lines of a diff. */
export function lensLeads(diff: string): LensLeads {
  const files = filesOf(diff).filter((f) => !f.deleted);
  const { smells, masking } = scanDiff(diff);
  const leads = emptyLeads();
  leads.CLEAN.push(...smells);
  leads.TESTS.push(...masking, ...files.flatMap(testDiffLeads));
  leads.SECURITY.push(...files.flatMap(securityLeads));
  leads.PERFORMANCE.push(...files.flatMap(performanceLeads));
  leads.DETERMINISM.push(...files.flatMap(determinismLeads));
  return leads;
}

// ── inside test bodies ─────────────────────────────────────────────

/** A test's opening line: `it(`/`test(` (JS/TS), or a test attribute (C#, Java). */
const BRACED_TEST = /\b(it|test)(\.(only|skip|concurrent|failing))?\s*\(/;
const ATTRIBUTE_TEST = /^\s*(\[(Fact|Theory|Test|TestMethod|TestCase)\b|@Test\b)/;
const PYTHON_TEST = /^(\s*)(async\s+)?def\s+test_\w*\s*\(/;
const BRACED_CONTROL: readonly (readonly [RegExp, string])[] = [
  [/\bif\s*\(/, 'an if'],
  [/\belse\b/, 'an else'],
  [/\bswitch\s*\(/, 'a switch'],
  [/\b(for|foreach|while)\s*\(|\bdo\s*\{|\.forEach\s*\(/, 'a loop'],
  [/\btry\s*\{|\bfinally\b/, 'a try/finally'],
];
const PYTHON_CONTROL: readonly (readonly [RegExp, string])[] = [
  [/^\s*(if|elif|else)\b/, 'an if'],
  [/^\s*(for|while)\b/, 'a loop'],
  [/^\s*(try|finally)\b/, 'a try/finally'],
];

interface TestBody {
  readonly name: string;
  /** [1-based line, text] of each line inside the body. */
  readonly lines: readonly (readonly [number, string])[];
}

const testName = (line: string): string =>
  /\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line)?.[2]?.replace(/\\(.)/g, '$1') ?? 'a test';
/** The method a test attribute marks, from the line under it. */
const methodName = (line: string): string => /(\w+)\s*\(/.exec(line)?.[1] ?? 'a test';

/** The lines between the brace that opens a test's body and the one that closes it. */
function bracedBody(lines: readonly string[], start: number, from: number): TestBody['lines'] {
  const body: [number, string][] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i += 1) {
    const code = codeOnly(lines[i]!).slice(i === start ? from : 0);
    if (opened) body.push([i + 1, lines[i]!]);
    for (const c of code) {
      if (c === '{') [depth, opened] = [depth + 1, true];
      else if (c === '}') depth -= 1;
    }
    if (opened && depth <= 0) return body.slice(0, -1);
  }
  return body;
}

function bracedTests(lines: readonly string[]): TestBody[] {
  const out: TestBody[] = [];
  lines.forEach((line, i) => {
    const code = codeOnly(line);
    const call = BRACED_TEST.exec(code);
    if (call) out.push({ name: testName(line), lines: bracedBody(lines, i, call.index) });
    else if (ATTRIBUTE_TEST.test(line))
      out.push({ name: methodName(lines[i + 1] ?? ''), lines: bracedBody(lines, i + 1, 0) });
  });
  return out;
}

function pythonTests(lines: readonly string[]): TestBody[] {
  const out: TestBody[] = [];
  lines.forEach((line, i) => {
    const m = PYTHON_TEST.exec(line);
    if (!m) return;
    const indent = m[1]!.length;
    const body: [number, string][] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j]!;
      if (l.trim() && l.length - l.trimStart().length <= indent) break;
      body.push([j + 1, l]);
    }
    out.push({ name: /def\s+(\w+)/.exec(line)?.[1] ?? 'a test', lines: body });
  });
  return out;
}

/** How a language marks its tests, its branches and its comments. */
interface Syntax {
  readonly tests: (lines: readonly string[]) => TestBody[];
  readonly control: readonly (readonly [RegExp, string])[];
  readonly code: (line: string) => string;
}

const BRACED: Syntax = { tests: bracedTests, control: BRACED_CONTROL, code: codeOnly };
const PYTHON: Syntax = { tests: pythonTests, control: PYTHON_CONTROL, code: pythonCodeOnly };

function bodyBreaks(path: string, test: TestBody, syntax: Syntax): string[] {
  const out: string[] = [];
  for (const [line, text] of test.lines) {
    const code = syntax.code(text);
    const at = (what: string, rule: string) =>
      out.push(`${path}:${line} — ${what} inside the test '${test.name}' (${rule})`);
    const branch = syntax.control.find(([pattern]) => pattern.test(code));
    if (branch) at(branch[1], 'UT-3.2');
    if (SLEEP.test(code)) at('a sleep', 'UT-11.2');
    if (CLOCK.test(code)) at('the real clock', 'DET-5');
  }
  return out;
}

/**
 * What a test file's test bodies hold that a test must not: branches, loops, try/finally
 * (UT-3.2), sleeps (UT-11.2) and the real clock (DET-5). Helpers outside the tests may branch.
 */
export function testBodyBreaks(path: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  const syntax = path.endsWith('.py') ? PYTHON : BRACED;
  const each = lines.flatMap((l, i) =>
    EACH.test(codeOnly(l))
      ? [`${path}:${i + 1} — test.each: write each case as its own named test (UT-3.2)`]
      : [],
  );
  return [...each, ...syntax.tests(lines).flatMap((t) => bodyBreaks(path, t, syntax))];
}

/** The test-body breaks on the lines a diff adds to a test file: an edit answers for its own. */
export function addedTestBreaks(file: FileDiff, text: string): string[] {
  const added = new Set(file.added.map(([line]) => line));
  return testBodyBreaks(file.path, text).filter((b) => added.has(Number(/:(\d+) — /.exec(b)?.[1])));
}
