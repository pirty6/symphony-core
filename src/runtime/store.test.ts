import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { toPerformance } from '../core/engine.js';
import { runScripted } from '../core/scripted.js';
import { fix, review } from '../patterns/index.js';
import {
  gitFingerprint,
  listRuns,
  loadPatternFiles,
  loadRun,
  runPath,
  savePatternFile,
  saveRun,
} from './store.js';

const root = mkdtempSync(join(tmpdir(), 'symphony-store-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('run store', () => {
  it('saves, lists and verifies runs', async () => {
    const dir = join(root, 'runs');
    const score = compileScore(fix, { goal: 'g', context: fix.demo!.context!, generatedAt: 't' });
    const performance = toPerformance(
      runScripted(score, fix.demo, { at: '2026-01-01T00:00:00Z' }).state,
    );
    const file = await saveRun(dir, { schemaVersion: 3, score, performance });
    const list = await listRuns(dir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      pattern: 'fix',
      outcome: 'success',
      goal: fix.demo!.context!.issue,
    });
    const loaded = await loadRun(file);
    expect(loaded.issues).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({ ...loaded.run, score: { ...loaded.run.score, goal: 'tampered' } }),
    );
    expect((await loadRun(file)).issues.join()).toMatch(/score id mismatch/);
  });

  it('refuses paths outside the store', () => {
    expect(runPath(root, 'fix/a.json')).toBe(join(root, 'fix/a.json'));
    expect(runPath(root, '../etc/passwd.json')).toBeUndefined();
    expect(runPath(root, 'fix/a.txt')).toBeUndefined();
  });

  it('returns no runs for a missing directory', async () => {
    expect(await listRuns(join(root, 'nope'))).toEqual([]);
  });
});

describe('pattern files', () => {
  it('writes TypeScript and loads it back', async () => {
    const dir = join(root, 'patterns');
    const file = await savePatternFile(
      dir,
      { ...review, name: 'my-review', demo: undefined },
      '../core/types.js',
    );
    expect(file.endsWith('my-review.ts')).toBe(true);
    const loaded = await loadPatternFiles(dir, (f) => import(pathToFileURL(f).href));
    expect(loaded.map((p) => p.name)).toEqual(['my-review']);
  });

  it('refuses invalid patterns', async () => {
    await expect(savePatternFile(join(root, 'p2'), { ...review, nodes: [] }, 'x')).rejects.toThrow(
      /start/,
    );
  });
});

describe('gitFingerprint', () => {
  it('changes when the workspace changes', async () => {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'a.txt'), '1');
    const a = await gitFingerprint(repo);
    writeFileSync(join(repo, 'a.txt'), '2');
    const b = await gitFingerprint(repo);
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
    expect(await gitFingerprint(repo)).toBe(b);
  });
});
