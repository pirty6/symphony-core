/**
 * Deterministic hints from a unified diff, for a code reviewer: smells in the added lines and
 * changes that may hide a failing test. They are leads for the reviewer to check, not findings.
 * Pure: the diff comes in as text.
 */

/** A path that is a test file. */
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[A-Za-z0-9]+$|_test\.go$|(^|\/)test_[^/]+\.py$/;
/** A line that asserts something. */
const ASSERTION = /\b(expect|assert\w*|should|t\.(Error|Fatal)\w*|Assert\.\w+)\b/;
const DEBUG_LEFTOVER =
  /\b(console\.(log|debug|trace)|debugger\b|pdb\.set_trace|breakpoint\(\)|binding\.pry|System\.out\.print|fmt\.Print|var_dump|print\()/;
/** A comment line that reads like code: it ends like a statement or holds an assignment or call. */
const COMMENTED_CODE = /^\s*(\/\/|#)\s*[\w$.[\]]+\s*(\(.*\)\s*;?|=\s*.+;|[{};])\s*$/;
const SIGNATURE =
  /\b(function|def|func|fn)\b[^(]*\(([^)]*)\)|\(([^()]*)\)\s*(:\s*[\w<>[\], |]+)?\s*=>/;
const SKIP_OR_FOCUS =
  /\b(it|test|describe)\.(skip|only|todo)\b|\b(xit|xdescribe|fit|fdescribe)\(|@(Ignore|Disabled)\b|pytest\.mark\.skip|\bt\.Skip\(/;
const RETRY_OR_WAIT = /\b(retry|retries|timeout|setTimeout|sleep|waitFor)\b/i;
/** A run of added lines this long in one hunk is worth a look as one long function. */
export const LONG_BLOCK = 50;

export interface DiffScan {
  /** "path:line — hint (rule id)": smells in the added lines. */
  readonly smells: readonly string[];
  /** "path — what changed": changes that may hide a failing test. */
  readonly masking: readonly string[];
}

interface FileDiff {
  readonly path: string;
  readonly deleted: boolean;
  /** [line in the new file, text] of each added line. */
  readonly added: (readonly [number, string])[];
  readonly removed: string[];
}

function filesOf(diff: string): FileDiff[] {
  const files: { path: string; deleted: boolean; added: [number, string][]; removed: string[] }[] =
    [];
  let cur: (typeof files)[number] | undefined;
  let line = 0;
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(l);
      cur = { path: m?.[1] ?? '', deleted: false, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (l.startsWith('deleted file mode')) cur.deleted = true;
    else if (l.startsWith('+++ ') || l.startsWith('--- ')) continue;
    else if (l.startsWith('@@')) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith('+')) cur.added.push([line++, l.slice(1)]);
    else if (l.startsWith('-')) cur.removed.push(l.slice(1));
    else if (!l.startsWith('\\')) line++;
  }
  return files;
}

/** Parameters in a signature's parameter list (top-level commas only). */
function paramCount(params: string): number {
  let depth = 0;
  let n = params.trim() ? 1 : 0;
  for (const c of params) {
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return params.trim().endsWith(',') ? n - 1 : n;
}

function smellsOf(f: FileDiff): string[] {
  const out: string[] = [];
  const at = (line: number, hint: string) => out.push(`${f.path}:${line} — ${hint}`);
  let run = 0;
  let runStart = 0;
  let prev = -1;
  for (const [line, text] of f.added) {
    run = line === prev + 1 ? run + 1 : 1;
    if (run === 1) runStart = line;
    if (run === LONG_BLOCK)
      at(runStart, `${LONG_BLOCK}+ added lines in one block: one long function? (G30)`);
    prev = line;
    if (DEBUG_LEFTOVER.test(text) && !TEST_FILE.test(f.path)) at(line, 'debug output left in (G12)');
    if (COMMENTED_CODE.test(text)) at(line, 'commented-out code (C5)');
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(text)) at(line, 'a TODO left in the change');
    const sig = SIGNATURE.exec(text);
    const params = sig?.[2] ?? sig?.[3];
    if (params !== undefined) {
      if (paramCount(params) > 3) at(line, `${paramCount(params)} parameters (F1)`);
      if (/:\s*boolean\b|=\s*(true|false)\b/.test(params)) at(line, 'a boolean parameter (F3)');
    }
  }
  return out;
}

function maskingOf(f: FileDiff): string[] {
  if (!TEST_FILE.test(f.path)) return [];
  const out: string[] = [];
  if (f.deleted) return [`${f.path} — test file deleted`];
  if (f.added.some(([, t]) => SKIP_OR_FOCUS.test(t)))
    out.push(`${f.path} — a test skipped or focused`);
  const removedAsserts = f.removed.filter((t) => ASSERTION.test(t)).length;
  const addedAsserts = f.added.filter(([, t]) => ASSERTION.test(t)).length;
  if (removedAsserts > addedAsserts)
    out.push(
      `${f.path} — ${removedAsserts - addedAsserts} more assertion line(s) removed than added`,
    );
  if (f.added.some(([, t]) => RETRY_OR_WAIT.test(t)))
    out.push(`${f.path} — a retry, timeout or wait added to a test`);
  return out;
}

export function scanDiff(diff: string): DiffScan {
  const files = filesOf(diff);
  return { smells: files.flatMap(smellsOf), masking: files.flatMap(maskingOf) };
}
