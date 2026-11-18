import { describe, expect, it } from 'vitest';
import { lensLeads, testBodyBreaks } from './lensscan.js';

/** A one-file diff that adds these lines at line 1 of `path`. */
const added = (path: string, lines: readonly string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');

describe('test-body breaks', () => {
  it('flags an if inside a test, with its line, the test and the rule', () => {
    const text = [
      "it('adds two numbers', () => {",
      '  const sum = add(1, 2);',
      '  if (sum > 0) expect(sum).toBe(3);',
      '});',
    ].join('\n');
    expect(testBodyBreaks('src/a.test.ts', text)).toEqual([
      "src/a.test.ts:3 — an if inside the test 'adds two numbers' (UT-3.2)",
    ]);
  });

  it('lets a helper outside the tests branch', () => {
    const text = [
      'const pick = (n: number) => {',
      '  if (n > 1) return n;',
      '  return 0;',
      '};',
      "it('picks', () => {",
      '  expect(pick(2)).toBe(2);',
      '});',
    ].join('\n');
    expect(testBodyBreaks('src/a.test.ts', text)).toEqual([]);
  });

  it('flags a loop and a try/finally in the test that holds them', () => {
    const text = [
      "test('reads every file', async () => {",
      '  try {',
      '    for (const f of files) expect(await read(f)).toBeTruthy();',
      '  } finally {',
      '    await cleanup();',
      '  }',
      '});',
    ].join('\n');
    expect(testBodyBreaks('src/b.test.ts', text)).toEqual([
      "src/b.test.ts:2 — a try/finally inside the test 'reads every file' (UT-3.2)",
      "src/b.test.ts:3 — a loop inside the test 'reads every file' (UT-3.2)",
      "src/b.test.ts:4 — a try/finally inside the test 'reads every file' (UT-3.2)",
    ]);
  });

  it('does not read keywords inside strings as code', () => {
    const text = [
      "it('says if (x) in its name', () => {",
      "  expect('for (;;)').toBe('for (;;)');",
      '});',
    ].join('\n');
    expect(testBodyBreaks('src/c.test.ts', text)).toEqual([]);
  });

  it('does not take a comment that says "it (…" for a test', () => {
    const text = [
      '/** Opens it (it then stays open). */',
      'async function open(page) {',
      '  if (closed) await toggle();',
      '}',
    ].join('\n');
    expect(testBodyBreaks('e2e/a.spec.ts', text)).toEqual([]);
  });

  it('keeps a test name whole when it holds an escaped quote', () => {
    const text = [
      "it('lists the machine\\'s runs', () => {",
      '  if (x) expect(x).toBe(1);',
      '});',
    ].join('\n');
    expect(testBodyBreaks('src/f.test.ts', text)).toEqual([
      "src/f.test.ts:2 — an if inside the test 'lists the machine's runs' (UT-3.2)",
    ]);
  });

  it('flags test.each: each case is its own named test', () => {
    const text = "it.each([1, 2])('handles %i', (n) => expect(n).toBeGreaterThan(0));";
    expect(testBodyBreaks('src/d.test.ts', text)).toEqual([
      'src/d.test.ts:1 — test.each: write each case as its own named test (UT-3.2)',
    ]);
  });

  it('flags a sleep and the real clock inside a test', () => {
    const text = [
      "it('expires the session', async () => {",
      '  await new Promise((r) => setTimeout(r, 50));',
      '  expect(expired(Date.now())).toBe(true);',
      '});',
    ].join('\n');
    expect(testBodyBreaks('src/e.test.ts', text)).toEqual([
      "src/e.test.ts:2 — a sleep inside the test 'expires the session' (UT-11.2)",
      "src/e.test.ts:3 — the real clock inside the test 'expires the session' (DET-5)",
    ]);
  });

  it('reads Python tests by indentation, and not their helpers', () => {
    const text = [
      'def helper(n):',
      '    if n > 1:',
      '        return n',
      '',
      'def test_total():',
      '    for n in [1, 2]:',
      '        assert total(n) > 0',
    ].join('\n');
    expect(testBodyBreaks('tests/test_total.py', text)).toEqual([
      "tests/test_total.py:6 — a loop inside the test 'test_total' (UT-3.2)",
    ]);
  });

  it('reads a C# test method by its attribute', () => {
    const text = [
      '[Fact]',
      'public void Totals_are_positive()',
      '{',
      '    foreach (var n in Numbers) Assert.True(Total(n) > 0);',
      '}',
    ].join('\n');
    expect(testBodyBreaks('Tests/TotalTests.cs', text)).toEqual([
      "Tests/TotalTests.cs:4 — a loop inside the test 'Totals_are_positive' (UT-3.2)",
    ]);
  });
});

describe('lens leads from a diff', () => {
  it('names a query built from values for the Security lens', () => {
    const leads = lensLeads(
      added('src/db.ts', ['const q = `SELECT * FROM users WHERE id = ${id}`;']),
    );
    expect(leads.SECURITY).toEqual(['src/db.ts:1 — a query built from values (SEC-1)']);
  });

  it('names a shell command built from values and eval', () => {
    const leads = lensLeads(added('src/run.ts', ['execSync(`git log ${branch}`);', 'eval(code);']));
    expect(leads.SECURITY).toEqual([
      'src/run.ts:1 — a shell command built from values (SEC-1)',
      'src/run.ts:2 — eval or unsafe deserialization (SEC-5)',
    ]);
  });

  it('names a credential, even in a test file', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const leads = lensLeads(added('src/auth.test.ts', [`const token = '${token}';`]));
    expect(leads.SECURITY).toEqual(['src/auth.test.ts:1 — a credential in the change (SEC-2)']);
  });

  it('names an await inside a loop for the Performance lens', () => {
    const leads = lensLeads(
      added('src/sync.ts', ['for (const id of ids) {', '  await save(id);', '}']),
    );
    expect(leads.PERFORMANCE).toEqual([
      'src/sync.ts:2 — an await inside a loop: one call per item? (PERF-1)',
    ]);
  });

  it('names the clock in production code for the Determinism lens, not in tests', () => {
    const prod = lensLeads(added('src/expiry.ts', ['const now = Date.now();']));
    const test = lensLeads(added('src/expiry.test.ts', ['const now = Date.now();']));
    expect(prod.DETERMINISM).toEqual([
      'src/expiry.ts:1 — reads the clock: should the time come in as an input? (DET-3)',
    ]);
    expect(test.DETERMINISM).toEqual([]);
  });

  it('gives the Clean code lens the smell scan, with rule ids', () => {
    const leads = lensLeads(added('src/f.ts', ['function f(a, b, c, d) {', '}']));
    expect(leads.CLEAN).toEqual(['src/f.ts:1 — 4 parameters (F1)']);
  });

  it('names a swallowed error for the Robustness lens', () => {
    const leads = lensLeads(
      added('src/load.ts', ['try { load(); } catch {}', 'save().catch(() => undefined);']),
    );
    expect(leads.ROBUSTNESS).toEqual([
      'src/load.ts:1 — an empty catch swallows the error (ROB-7)',
      'src/load.ts:2 — a .catch that drops the error (ROB-7)',
    ]);
  });

  it('names a network call without a timeout', () => {
    const leads = lensLeads(added('src/api.ts', ['const res = await fetch(url);']));
    expect(leads.ROBUSTNESS).toEqual(['src/api.ts:1 — a network call without a timeout (ROB-4)']);
  });

  it('lets a network call whose options on the next lines carry a signal', () => {
    const leads = lensLeads(
      added('src/api.ts', [
        'const res = await fetch(url, {',
        "  method: 'POST',",
        '  signal: AbortSignal.timeout(TIMEOUT_MS),',
        '});',
      ]),
    );
    expect(leads.ROBUSTNESS).toEqual([]);
  });

  it('names an endless loop and an abrupt exit', () => {
    const leads = lensLeads(added('src/poll.ts', ['while (true) {', '  process.exit(1);', '}']));
    expect(leads.ROBUSTNESS).toEqual([
      'src/poll.ts:1 — an endless loop: when does it give up? (ROB-4)',
      'src/poll.ts:2 — exits at once: is the work so far kept? (ROB-5)',
    ]);
  });

  it('leaves robustness in test files to the Tests lens', () => {
    const leads = lensLeads(added('src/load.test.ts', ['try { load(); } catch {}']));
    expect(leads.ROBUSTNESS).toEqual([]);
  });

  it('names an error that says nothing for the Usability lens', () => {
    const leads = lensLeads(
      added('src/cli.ts', ["throw new Error('Invalid input');", 'throw new Error();']),
    );
    expect(leads.USABILITY).toEqual([
      'src/cli.ts:1 — an error that says neither what failed nor why (USE-2)',
      'src/cli.ts:2 — an error that says neither what failed nor why (USE-2)',
    ]);
  });

  it('lets an error that names the value and what to do', () => {
    const leads = lensLeads(
      added('src/cli.ts', ['throw new Error(`unknown pattern ${name}: run list to see them`);']),
    );
    expect(leads.USABILITY).toEqual([]);
  });

  it('names a block of logic added in two places for the Reusability lens, once', () => {
    const block = [
      'const total = items.reduce((sum, item) => sum + item.price, 0);',
      'const taxed = total * (1 + order.taxRate);',
      'const rounded = Math.round(taxed * 100) / 100;',
      'return rounded > order.limit ? order.limit : rounded;',
    ];
    const leads = lensLeads(
      [added('src/cart.ts', block), added('src/invoice.ts', ['', ...block])].join('\n'),
    );
    expect(leads.REUSABILITY).toEqual([
      'src/cart.ts:1 — the same lines are added again at src/invoice.ts:2: one shared helper? (REU-2)',
    ]);
  });

  it('does not take repeated closing braces for duplicated logic', () => {
    const closing = ['    }', '  }', '}'];
    const leads = lensLeads([added('src/a.ts', closing), added('src/b.ts', closing)].join('\n'));
    expect(leads.REUSABILITY).toEqual([]);
  });

  it('gives the Tests lens test.each and what may hide a failing test', () => {
    const leads = lensLeads(
      added('src/g.test.ts', ["it.skip('works', () => {});", 'it.each([1])("n", () => {});']),
    );
    expect(leads.TESTS).toEqual([
      'src/g.test.ts — a test skipped or focused',
      'src/g.test.ts:2 — test.each: write each case as its own named test (UT-3.2)',
    ]);
  });
});
