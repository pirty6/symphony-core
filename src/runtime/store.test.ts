import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  isDemoRun,
  runsDirFor,
  runScratch,
  autoPrune,
  listRuns,
  pruneRuns,
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

describe('demo runs stay out of your lists', () => {
  const score = compileScore(fix, { context: fix.demo!.context!, generatedAt: 't' });
  const perf = toPerformance(runScripted(score, fix.demo, { at: 't' }).state);
  const live = {
    ...perf,
    steps: perf.steps.map((s) =>
      s.transcript ? { ...s, transcript: { ...s.transcript, provider: 'copilot' } } : s,
    ),
  };

  it('knows a demo run by its provider, or (older runs) by who answered', () => {
    expect(isDemoRun({ ...perf, provider: 'scripted' })).toBe(true);
    expect(isDemoRun({ ...perf, provider: 'copilot' })).toBe(false);
    expect(isDemoRun(perf)).toBe(true);
    expect(isDemoRun(live)).toBe(false);
    expect(isDemoRun({ ...perf, steps: [] })).toBe(false);
  });

  it('lists them flagged, and SYMPHONY_RUNS_DIR moves where runs are saved', async () => {
    const dir = join(root, 'demo-flag');
    await saveRun(dir, { schemaVersion: 3, score, performance: perf });
    await saveRun(dir, { schemaVersion: 3, score, performance: { ...live, startedAt: 'u' } });
    expect((await listRuns(dir)).map((r) => r.demo).toSorted()).toEqual([false, true]);
    expect(runsDirFor('/repo', {})).toBe(join('/repo', '.symphony', 'runs'));
    expect(runsDirFor('/repo', { SYMPHONY_RUNS_DIR: '/tmp/x' })).toBe('/tmp/x');
  });
});

describe('run scratch folders', () => {
  it('each run gets its own folder under .symphony/scratch, removed at the end', async () => {
    const a = await runScratch(root, {});
    const b = await runScratch(root, {});
    expect(a.dir).not.toBe(b.dir);
    expect(a.dir.startsWith(join(root, '.symphony', 'scratch'))).toBe(true);
    writeFileSync(join(a.dir, 'bench.sh'), 'echo hi');
    await a.remove();
    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(b.dir)).toBe(true);
    await b.remove();
  });

  it('SYMPHONY_KEEP_SCRATCH=1 keeps it for debugging', async () => {
    const kept = await runScratch(root, { SYMPHONY_KEEP_SCRATCH: '1' });
    await kept.remove();
    expect(existsSync(kept.dir)).toBe(true);
  });
});

describe('retention: saved runs do not pile up', () => {
  const score = compileScore(fix, { context: fix.demo!.context!, generatedAt: 't' });
  const perf = toPerformance(runScripted(score, fix.demo, { at: 't' }).state);
  const DAY = 86_400_000;

  async function workspace() {
    const ws = mkdtempSync(join(root, 'ws-'));
    const dir = join(ws, '.symphony', 'runs');
    const save = (startedAt: string, provider: string) =>
      saveRun(dir, { schemaVersion: 3, score, performance: { ...perf, startedAt, provider } });
    const files = {
      oldDemo: await save('a', 'scripted'),
      newDemo: await save('b', 'scripted'),
      oldReal: await save('c', 'copilot'),
      newReal: await save('d', 'copilot'),
    };
    const scratch = join(ws, '.symphony', 'scratch');
    mkdirSync(join(scratch, 'crashed'), { recursive: true });
    mkdirSync(join(scratch, 'running'), { recursive: true });
    const days: Record<string, number> = {
      [files.oldDemo]: 8,
      [files.newDemo]: 2,
      [files.oldReal]: 31,
      [files.newReal]: 29,
      [join(scratch, 'crashed')]: 2,
      [join(scratch, 'running')]: 0.1,
    };
    const age = (f: string) => (days[f] ?? 0) * DAY;
    return { ws, dir, files, scratch, age };
  }

  it('deletes old demo runs, compacts old real runs and clears crashed scratch', async () => {
    const { dir, files, scratch, age } = await workspace();
    const before = statSync(files.oldReal).size;
    const dry = await pruneRuns(dir, { scratchDir: scratch, age, dryRun: true });
    expect(dry.deleted).toHaveLength(1);
    expect(existsSync(files.oldDemo)).toBe(true);
    expect(statSync(files.oldReal).size).toBe(before);

    const report = await pruneRuns(dir, { scratchDir: scratch, age });
    expect(report).toEqual({ ...dry });
    expect(report.compacted).toEqual([files.oldReal.slice(dir.length + 1)]);
    expect(report.scratch).toEqual([join(scratch, 'crashed')]);
    expect(existsSync(files.oldDemo)).toBe(false);
    expect([files.newDemo, files.newReal].every((f) => existsSync(f))).toBe(true);
    expect(existsSync(join(scratch, 'running'))).toBe(true);
    expect(statSync(files.oldReal).size).toBeLessThan(before);
    expect(JSON.parse(readFileSync(files.oldReal, 'utf8')).performance.compacted).toBe(true);
  });

  it('a compacted run loads with its timeline rebuilt and still verifies', async () => {
    const { dir, files, age } = await workspace();
    await pruneRuns(dir, { age });
    const { run, issues } = await loadRun(files.oldReal);
    expect(issues).toEqual([]);
    expect(run.performance.compacted).toBe(true);
    expect(run.performance.events).toEqual(perf.events);
  });

  it('runs by itself at most once a day, and SYMPHONY_RETENTION=off turns it off', async () => {
    const { ws, dir } = await workspace();
    expect(await autoPrune(ws, dir, { SYMPHONY_RETENTION: 'off' })).toBeUndefined();
    expect(await autoPrune(ws, dir, {})).toBeDefined();
    expect(existsSync(join(dir, '.last-prune'))).toBe(true);
    expect(await autoPrune(ws, dir, {})).toBeUndefined();
    expect((await listRuns(dir)).length).toBe(4);
  });
});
