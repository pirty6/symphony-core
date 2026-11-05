import { describe, expect, it } from 'vitest';
import { LONG_BLOCK, scanDiff } from './diffscan.js';

const file = (path: string, hunk: string, extra = '') =>
  `diff --git a/${path} b/${path}\n${extra}--- a/${path}\n+++ b/${path}\n${hunk}`;

describe('scanDiff', () => {
  it('finds smells in added lines, at their line in the new file', () => {
    const diff = file(
      'src/a.ts',
      [
        '@@ -1,2 +10,6 @@',
        ' const keep = 1;',
        '+export function make(a: string, b: number, c: string, d: number) {',
        '+  console.log(a);',
        '+  // total = sum(items);',
        '+}',
        '+const run = (name: string, force: boolean) => name;',
      ].join('\n'),
    );
    expect(scanDiff(diff).smells).toEqual([
      'src/a.ts:11 — 4 parameters (F1)',
      'src/a.ts:12 — debug output left in (G12)',
      'src/a.ts:13 — commented-out code (C5)',
      'src/a.ts:15 — a boolean parameter (F3)',
    ]);
  });

  it('flags one long added block once', () => {
    const lines = Array.from({ length: LONG_BLOCK + 5 }, (_, i) => `+  x${i} += 1;`);
    const diff = file('src/b.ts', [`@@ -0,0 +1,${lines.length} @@`, ...lines].join('\n'));
    expect(scanDiff(diff).smells).toEqual([
      `src/b.ts:1 — ${LONG_BLOCK}+ added lines in one block: one long function? (G30)`,
    ]);
  });

  it('flags changes that may hide a failing test, and leaves sound test edits alone', () => {
    const skipped = file(
      'test/a.test.ts',
      [
        '@@ -1,3 +1,3 @@',
        "-it('adds', () => {",
        "+it.skip('adds', () => {",
        '-  expect(add(1, 2)).toBe(3);',
        '+  add(1, 2);',
      ].join('\n'),
    );
    const deleted = file('src/b.spec.ts', '@@ -1 +0,0 @@\n-test()', 'deleted file mode 100644\n');
    const sound = file(
      'test/c.test.ts',
      ['@@ -1 +1,2 @@', ' x', '+  expect(c()).toBe(1);'].join('\n'),
    );
    expect(scanDiff(skipped + '\n' + deleted + '\n' + sound).masking).toEqual([
      'test/a.test.ts — a test skipped or focused',
      'test/a.test.ts — 1 more assertion line(s) removed than added',
      'src/b.spec.ts — test file deleted',
    ]);
  });

  it('does not count debug output in tests or masking in production code', () => {
    const diff =
      file('test/x.test.ts', '@@ -0,0 +1 @@\n+console.log(1);') +
      '\n' +
      file('src/x.ts', '@@ -1 +1 @@\n-expect(1)\n+setTimeout(f, 10);');
    expect(scanDiff(diff)).toEqual({ smells: [], masking: [] });
  });
});
