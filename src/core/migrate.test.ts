import { describe, expect, it } from 'vitest';
import { compileScore } from './compile.js';
import { toPerformance } from './engine.js';
import { ENGINE_VERSION, engineNote, migrateRun, RUN_SCHEMA_VERSION } from './migrate.js';
import { replayPerformance } from './replay.js';
import { runScripted } from './scripted.js';
import { fix } from '../patterns/index.js';

const score = compileScore(fix, { context: fix.demo!.context!, generatedAt: 't' });
const performance = toPerformance(runScripted(score, fix.demo, { at: 't' }).state);

describe('migrateRun', () => {
  it('stamps new runs with the current format and engine', () => {
    expect(performance).toMatchObject({
      schemaVersion: RUN_SCHEMA_VERSION,
      engine: ENGINE_VERSION,
    });
    const m = migrateRun({ schemaVersion: 3, score, performance });
    expect(m).toEqual({ run: { schemaVersion: 3, score, performance }, migrated: [], issues: [] });
  });

  it('upgrades a format 2 run, which then still replays exactly', () => {
    const { engine: _e, ...old } = performance;
    const m = migrateRun({ schemaVersion: 2, score, performance: { ...old, schemaVersion: 2 } });
    expect(m.issues).toEqual([]);
    expect(m.migrated).toEqual([expect.stringMatching(/^format 2 → 3/)]);
    expect(m.run!.performance).toMatchObject({ schemaVersion: 3, engine: '0' });
    expect(replayPerformance(m.run!.score, m.run!.performance).divergence.reproduced).toBe(true);
  });

  it('refuses unknown and newer formats with a reason', () => {
    expect(migrateRun({ schemaVersion: 1 }).issues[0]).toMatch(
      /format 1 is not supported; this engine reads 2..3/,
    );
    expect(migrateRun({}).issues[0]).toMatch(/format undefined is not supported/);
    expect(migrateRun({ schemaVersion: 9 }).issues[0]).toMatch(/written by a newer engine/);
  });

  it('notes when a run was recorded by another engine version', () => {
    expect(engineNote(ENGINE_VERSION)).toBeUndefined();
    expect(engineNote('0')).toMatch(`recorded by engine 0, replayed with engine ${ENGINE_VERSION}`);
    expect(engineNote(undefined)).toMatch(/recorded by engine 0/);
  });
});
