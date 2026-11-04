import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  readBaseline,
  rejectionReport,
  runRejections,
  savedRejections,
  writeBaseline,
} from './rejections.js';
import type { SavedRun } from '../core/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'symphony-rejections-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const verdict = { outcome: 'applied', confidence: 0.5, shouldTerminate: false, reason: 'r' };
/** A run whose locate step was rejected four times, as the 2026-11-03 investigate run was. */
const run = {
  score: {
    pattern: 'investigate',
    state: [{ name: 'scopeFiles', type: 'string[]' }],
    nodes: [
      { id: 'locate', kind: 'agent', writes: ['scopeFiles'] },
      { id: 'scan', kind: 'tool' },
    ],
  },
  performance: {
    steps: [{ nodeId: 'scan', step: 1, attempts: [{ errors: ['x must be y'], result: {} }] }],
    pending: {
      nodeId: 'locate',
      step: 2,
      attempts: [
        // Repaired today: no shouldTerminate.
        {
          errors: ['verdict.shouldTerminate must be boolean'],
          result: {
            updates: { scopeFiles: ['a.ts'] },
            verdict: { ...verdict, shouldTerminate: undefined },
          },
        },
        // A step's own check: needs the run's state, counted only.
        {
          errors: [
            'scopeFiles may only list files of this repository. (check failed: subset(scopeFiles, repoFiles))',
          ],
          result: { updates: { scopeFiles: ['src/'] }, verdict },
        },
        // Still wrong: no verdict at all.
        {
          errors: ['verdict is missing: send it next to updates'],
          result: { updates: { scopeFiles: ['a.ts'] } },
        },
        // Shape, but the raw answer was not kept (older runs).
        { errors: ['verdict must be an object'] },
      ],
    },
  },
} as unknown as SavedRun;

describe('rejections', () => {
  it("replays each rejected shape through today's repairs; checks are only counted", () => {
    const all = runRejections(run, 'investigate/r.json');
    expect(all.map((r) => [r.key, r.kind, r.passesNow])).toEqual([
      ['investigate/r.json#2.1', 'shape', true],
      ['investigate/r.json#2.2', 'check', undefined],
      ['investigate/r.json#2.3', 'shape', false],
      ['investigate/r.json#2.4', 'shape', undefined],
    ]);
    const report = rejectionReport(all);
    expect(report).toMatchObject({
      total: 4,
      byKind: { shape: 3, check: 1, other: 0 },
      replayable: 2,
      passing: 1,
      regressions: [],
    });
    expect(report.stillFailing[0]!.why).toMatch(/^verdict is missing/);
  });

  it('an answer the baseline had passing that fails now is a regression', async () => {
    const runs = join(tmp, 'runs');
    mkdirSync(join(runs, 'investigate'), { recursive: true });
    writeFileSync(join(runs, 'investigate', 'r.json'), JSON.stringify(run));
    writeFileSync(join(runs, 'investigate', 'broken.json'), '{');
    const all = await savedRejections(runs);
    expect(all).toHaveLength(4);
    await writeBaseline(tmp, all);
    const baseline = await readBaseline(tmp);
    expect([...baseline!]).toEqual(['investigate/r.json#2.1']);
    expect(rejectionReport(all, baseline).regressions).toEqual([]);
    // A repair that stopped working: the same answer now fails.
    const worse = all.map((r) =>
      r.passesNow ? Object.assign({}, r, { passesNow: false, why: 'broken' }) : r,
    );
    expect(rejectionReport(worse, baseline).regressions.map((r) => r.key)).toEqual([
      'investigate/r.json#2.1',
    ]);
    expect(await readBaseline(join(tmp, 'none'))).toBeUndefined();
  });
});
