import { describe, expect, it } from 'vitest';
import { resolvePaths } from './paths.js';

const repo = [
  'src/a.ts',
  'src/b c.ts',
  'src/core/engine.ts',
  'src/core/engine.test.ts',
  'docs/x.md',
  'a.ts',
];

describe('resolvePaths', () => {
  it('resolves files written another way, folders and globs, in the order named, each once', () => {
    const r = resolvePaths(
      ['./src/a.ts', 'src/core/', 'src/**/*.test.ts', '/Users/me/repo/a.ts', 'src\\a.ts'],
      ['grep hit', 'imports', 'tests', 'blame', 'again'],
      repo,
      100,
    );
    expect(r.files).toEqual(['src/a.ts', 'src/core/engine.ts', 'src/core/engine.test.ts', 'a.ts']);
    expect(r.reasons).toEqual([
      'grep hit',
      'imports (in src/core/)',
      'imports (in src/core/)',
      'blame',
    ]);
    expect(r.unmatched).toEqual([]);
  });

  it('names what matches nothing instead of guessing', () => {
    const r = resolvePaths(['lib/x.ts', 'src/core/missing.ts', 'nothing/*', '', 3], [], repo, 10);
    expect(r.files).toEqual([]);
    expect(r.unmatched).toEqual([
      'lib/x.ts — not a file of this repository',
      'src/core/missing.ts — not a file of this repository',
      'nothing/* — not a file of this repository',
    ]);
    // A folder named like a file prefix is not a match: "src/core/eng" is no folder.
    expect(resolvePaths(['src/core/eng'], [], repo, 10).files).toEqual([]);
    // "." and "/" never mean the whole repository.
    expect(resolvePaths(['.', '/'], [], repo, 10).files).toEqual([]);
  });

  it('keeps the first max files, most likely first, and names the rest', () => {
    const r = resolvePaths(['src/'], ['folder'], repo, 2);
    expect(r.files).toEqual(['src/a.ts', 'src/b c.ts']);
    expect(r.over).toEqual(['src/core/engine.ts', 'src/core/engine.test.ts']);
  });

  it('a folder whose name has brackets is a folder, not a character class', () => {
    const app = ['app/[id]/page.tsx', 'app/[id]/layout.tsx', 'app/i/x.tsx'];
    expect(resolvePaths(['app/[id]/'], [], app, 10).files).toEqual([
      'app/[id]/page.tsx',
      'app/[id]/layout.tsx',
    ]);
    expect(resolvePaths(['app/[id]'], [], app, 10).unmatched).toEqual([]);
  });

  it('single-character and bracket globs stay within one folder', () => {
    expect(resolvePaths(['src/?.ts'], [], repo, 10).files).toEqual(['src/a.ts']);
    expect(resolvePaths(['src/[ab]*.ts'], [], repo, 10).files).toEqual(['src/a.ts', 'src/b c.ts']);
    expect(resolvePaths(['*.ts'], [], repo, 10).files).toEqual(['a.ts']);
  });
});
