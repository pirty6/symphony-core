import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { rankFiles, termsOf } from './rank.js';

const ws = mkdtempSync(join(tmpdir(), 'symphony-rank-'));
afterAll(() => rmSync(ws, { recursive: true, force: true }));
mkdirSync(join(ws, 'src'));
writeFileSync(join(ws, 'README.md'), '# demo\n');
writeFileSync(join(ws, 'src', 'a.ts'), 'export const x = 1;\n');
writeFileSync(join(ws, 'src', 'retry.ts'), 'export function backoff() { /* retry timeout */ }\n');
writeFileSync(join(ws, 'src', 'client.ts'), 'import { backoff } from "./retry";\n');
execFileSync('git', ['init', '-q'], { cwd: ws });
execFileSync('git', ['add', '.'], { cwd: ws });

describe('repo.rank', () => {
  const paths = ['README.md', 'src/a.ts', 'src/client.ts', 'src/retry.ts'];

  it('orders every path by the words it shares with the question, path names counting double', async () => {
    const r = await rankFiles(ws, paths, ['Why does the client retry after a timeout?']);
    expect(r.ranked).toEqual(['src/retry.ts', 'src/client.ts', 'README.md', 'src/a.ts']);
    expect(r.matched).toEqual(['src/retry.ts', 'src/client.ts']);
    // An order, never a filter.
    expect(r.ranked.toSorted()).toEqual(paths.toSorted());
  });

  it('uses no common words, and keeps the given order on ties (no hit at all: unchanged)', async () => {
    expect(termsOf(['What does this code do, and where?'])).toEqual([]);
    const r = await rankFiles(ws, paths, ['zzz unrelated words']);
    expect(r.ranked).toEqual(paths);
    expect(r.matched).toEqual([]);
  });

  it('outside a git repository ranks by path names only', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'symphony-rank-plain-'));
    try {
      const r = await rankFiles(plain, paths, ['client retry']);
      expect(r.ranked.slice(0, 2)).toEqual(['src/client.ts', 'src/retry.ts']);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
