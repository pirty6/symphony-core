/**
 * Every answer the engine rejected in this workspace's saved runs, played again through today's
 * repairs (normalizeSubmission) and shape check. A change to either must never turn an answer
 * that passes back into one that fails: the answers that pass are kept as a baseline in the
 * workspace's Symphony folder (on this machine, like the runs), and a later check names any
 * that no longer pass. Content checks ("at least 3 hypotheses") need the state of the run at
 * that step, so they are counted, not replayed.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkAgentResult } from '../core/schema.js';
import type { SavedRun, StateField } from '../core/types.js';
import { normalizeSubmission } from './copilot-provider.js';

export interface Rejection {
  /** "<run file>#<step>.<attempt>": stable while the run file is kept. */
  readonly key: string;
  readonly nodeId: string;
  /** shape: the answer's form was wrong; check: a step's own check failed; other. */
  readonly kind: 'shape' | 'check' | 'other';
  /** For a shape rejection with the raw answer kept: whether it passes now. */
  readonly passesNow?: boolean;
  /** What still fails, when it does. */
  readonly why?: string;
}

const kindOf = (errors: readonly string[]): Rejection['kind'] =>
  errors.length > 0 && errors.every((e) => /\(check (failed|'.*' errored)/.test(e))
    ? 'check'
    : errors.some((e) => /^(verdict|updates|next)\b|must be|is missing|not writable|got /.test(e))
      ? 'shape'
      : 'other';

/** The rejected answers of one saved run, the stuck step's (pending) included. */
export function runRejections(run: SavedRun, name: string): Rejection[] {
  const fields = new Map<string, StateField>(run.score.state.map((f) => [f.name, f]));
  const out: Rejection[] = [];
  const steps = [
    ...run.performance.steps.map((s) => ({ nodeId: s.nodeId, step: s.step, attempts: s.attempts })),
    ...(run.performance.pending ? [run.performance.pending] : []),
  ];
  for (const s of steps) {
    const node = run.score.nodes.find((n) => n.id === s.nodeId);
    if (node?.kind !== 'agent') continue;
    const writes = node.writes.flatMap((w) => (fields.get(w) ? [fields.get(w)!] : []));
    for (const [i, a] of (s.attempts ?? []).entries()) {
      const kind = kindOf(a.errors);
      const base = { key: `${name}#${s.step}.${i + 1}`, nodeId: s.nodeId, kind };
      if (kind !== 'shape' || a.result === undefined) {
        out.push(base);
        continue;
      }
      const now = checkAgentResult(normalizeSubmission(a.result), writes);
      out.push(
        now.ok ? { ...base, passesNow: true } : { ...base, passesNow: false, why: now.errors[0] },
      );
    }
  }
  return out;
}

/** Every saved run's rejections under a runs folder (one sub-folder per pattern). */
export async function savedRejections(runsDir: string): Promise<Rejection[]> {
  const out: Rejection[] = [];
  const folders = await readdir(runsDir).catch(() => [] as string[]);
  for (const folder of folders.toSorted()) {
    const files = await readdir(join(runsDir, folder)).catch(() => [] as string[]);
    for (const f of files.filter((x) => x.endsWith('.json')).toSorted()) {
      try {
        const run = JSON.parse(await readFile(join(runsDir, folder, f), 'utf8')) as SavedRun;
        if (run?.score?.nodes && run.performance?.steps)
          out.push(...runRejections(run, `${folder}/${f}`));
      } catch {
        // A run being written, or not a run: nothing to replay.
      }
    }
  }
  return out;
}

export interface RejectionReport {
  readonly total: number;
  readonly byKind: Readonly<Record<Rejection['kind'], number>>;
  /** Shape rejections with the raw answer kept, and how many of them pass now. */
  readonly replayable: number;
  readonly passing: number;
  /** Why the others still fail, most frequent first. */
  readonly stillFailing: readonly { readonly why: string; readonly count: number }[];
  /** Passed in the baseline, fail now: a repair got worse. */
  readonly regressions: readonly Rejection[];
}

export function rejectionReport(
  all: readonly Rejection[],
  baseline: ReadonlySet<string> = new Set(),
): RejectionReport {
  const byKind = { shape: 0, check: 0, other: 0 };
  for (const r of all) byKind[r.kind] += 1;
  const replayed = all.filter((r) => r.passesNow !== undefined);
  const why = new Map<string, number>();
  for (const r of replayed)
    if (!r.passesNow) {
      const k = (r.why ?? '').replace(/"[^"]*"/g, '"…"').slice(0, 120);
      why.set(k, (why.get(k) ?? 0) + 1);
    }
  return {
    total: all.length,
    byKind,
    replayable: replayed.length,
    passing: replayed.filter((r) => r.passesNow).length,
    stillFailing: [...why]
      .map(([w, count]) => ({ why: w, count }))
      .toSorted((a, b) => b.count - a.count),
    regressions: replayed.filter((r) => !r.passesNow && baseline.has(r.key)),
  };
}

const BASELINE = 'rejections-baseline.json';

export async function readBaseline(stateFolder: string): Promise<Set<string> | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(stateFolder, BASELINE), 'utf8')) as {
      passing?: unknown;
    };
    return Array.isArray(raw.passing)
      ? new Set(raw.passing.filter((x): x is string => typeof x === 'string'))
      : undefined;
  } catch {
    return undefined;
  }
}

/** The answers that pass now become the baseline (those of deleted runs drop out). */
export async function writeBaseline(stateFolder: string, all: readonly Rejection[]): Promise<void> {
  const passing = all.filter((r) => r.passesNow).map((r) => r.key);
  await writeFile(join(stateFolder, BASELINE), `${JSON.stringify({ passing }, null, 2)}\n`);
}
