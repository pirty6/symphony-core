/**
 * Saved runs across engine versions. A run embeds its Score, so pattern changes
 * never affect replay; what can change is the engine. Every Performance records
 * the engine version that played it, and older run formats are upgraded through
 * an ordered list of pure migrations before they are replayed.
 */
import type { SavedRun } from './types.js';

/** Bump when advance() could take a different path for the same recorded answers. */
export const ENGINE_VERSION = '1.0.0';

/** The run format this engine writes. */
export const RUN_SCHEMA_VERSION = 3;

/** Engine version stamped on runs recorded before versions were recorded. */
export const UNVERSIONED_ENGINE = '0';

interface Migration {
  readonly from: number;
  readonly to: number;
  readonly note: string;
  readonly up: (raw: Record<string, unknown>) => Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const MIGRATIONS: readonly Migration[] = [
  {
    from: 2,
    to: 3,
    note: `format 2 → 3: recorded before engine versions; marked engine '${UNVERSIONED_ENGINE}'`,
    up: (raw) => ({
      ...raw,
      schemaVersion: 3,
      performance: { ...obj(raw.performance), schemaVersion: 3, engine: UNVERSIONED_ENGINE },
    }),
  },
];

export interface Migrated {
  readonly run?: SavedRun;
  /** Migrations applied, oldest first. */
  readonly migrated: readonly string[];
  readonly issues: readonly string[];
}

/** Bring a parsed run file up to RUN_SCHEMA_VERSION. Pure. */
export function migrateRun(raw: unknown): Migrated {
  let run = obj(raw);
  const migrated: string[] = [];
  const oldest = MIGRATIONS[0]?.from ?? RUN_SCHEMA_VERSION;
  for (;;) {
    const v = run.schemaVersion;
    if (v === RUN_SCHEMA_VERSION) return { run: run as unknown as SavedRun, migrated, issues: [] };
    if (typeof v === 'number' && v > RUN_SCHEMA_VERSION) {
      return {
        migrated,
        issues: [
          `run format ${v} was written by a newer engine; this one reads ${oldest}..${RUN_SCHEMA_VERSION}`,
        ],
      };
    }
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) {
      return {
        migrated,
        issues: [
          `run format ${JSON.stringify(v)} is not supported; this engine reads ${oldest}..${RUN_SCHEMA_VERSION}`,
        ],
      };
    }
    run = step.up(run);
    migrated.push(step.note);
  }
}

/** Why a replay might diverge for engine reasons, if the versions differ. */
export function engineNote(recorded: string | undefined): string | undefined {
  const v = recorded ?? UNVERSIONED_ENGINE;
  return v === ENGINE_VERSION
    ? undefined
    : `recorded by engine ${v}, replayed with engine ${ENGINE_VERSION}: a divergence may come from engine changes, not from the run`;
}
