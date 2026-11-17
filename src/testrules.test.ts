import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_FILE } from './core/diffscan.js';
import { testBodyBreaks } from './core/lensscan.js';

const REPO = join(import.meta.dirname, '..');
const TEST_ROOTS = ['src', 'packages/ui/src', 'packages/ui/server', 'packages/ui/e2e'];

function testFiles(): string[] {
  return TEST_ROOTS.flatMap((root) =>
    readdirSync(join(REPO, root), { recursive: true, encoding: 'utf8' })
      .map((path) => `${root}/${path.replaceAll('\\', '/')}`)
      .filter((path) => TEST_FILE.test(path) && /\.tsx?$/.test(path)),
  ).toSorted();
}

function breaksIn(path: string): string[] {
  return testBodyBreaks(path, readFileSync(join(REPO, path), 'utf8'));
}

describe("Symphony's own tests follow the test rules it enforces", () => {
  it('finds the test files of the core and the studio', () => {
    expect(testFiles()).toEqual(
      expect.arrayContaining([
        'src/testrules.test.ts',
        'packages/ui/server/api.test.ts',
        'packages/ui/e2e/studio.spec.ts',
      ]),
    );
  });

  it('no test body holds logic, sleeps, the real clock or test.each (UT-3.2, UT-11.2)', () => {
    expect(testFiles().flatMap(breaksIn)).toEqual([]);
  });
});
