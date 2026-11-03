import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { fix } from '../patterns/index.js';
import { Run } from './driver.js';
import { liveRoot, LiveRuns, publishLive, pruneLive } from './live.js';
import { ScriptedProvider } from './scripted-provider.js';

const roots: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'symphony-live-'));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const until = async (ok: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const fixRun = () =>
  new Run({
    score: compileScore(fix, { context: fix.demo!.context!, generatedAt: 't' }),
    provider: ScriptedProvider.forPattern(fix),
    demo: fix.demo,
    autoApprove: false,
    clock: () => 't',
  });

describe('live runs: a run another process plays, in the studio', () => {
  it('shows it as it plays, takes an approval from the studio, and follows it to the end', async () => {
    const dir = root();
    const run = fixRun();
    const stop = await publishLive(run, { source: 'chat', workspace: '/w' }, dir);
    const done = run.start();
    await until(() => run.status === 'awaiting-approval');

    const studio = new LiveRuns(dir);
    const [seen] = await studio.list();
    expect(seen).toMatchObject({ id: run.id, source: 'chat', workspace: '/w' });
    expect(seen!.score.pattern).toBe('fix');
    await until(async () => (await seen!.poll(), seen!.status === 'awaiting-approval'));

    // The studio answers; the process that plays the run applies it.
    const streamed: number[] = [];
    seen!.subscribe((m) => streamed.push(m.seq));
    expect(seen!.answerApproval({ approved: true })).toBeUndefined();
    await done;
    expect(run.status).toBe('done');
    await until(async () => (await seen!.poll(), seen!.status === 'done'));
    expect(seen!.messages.map((m) => m.seq)).toEqual(run.messages.map((m) => m.seq));
    expect(streamed.length).toBeGreaterThan(0);
    expect(seen!.answerApproval({ approved: true })).toBe('the run has ended');
    stop();
    studio.dispose();
  });

  it('a run whose process is gone ends as cancelled, so the studio is not left waiting', async () => {
    const dir = root();
    const run = fixRun();
    mkdirSync(join(dir, run.id));
    writeFileSync(
      join(dir, run.id, 'meta.json'),
      JSON.stringify({
        id: run.id,
        pattern: 'fix',
        goal: 'g',
        source: 'chat',
        workspace: '/w',
        pid: 2 ** 22 + 12345,
        startedAt: 't',
        score: run.score,
      }),
    );
    writeFileSync(
      join(dir, run.id, 'messages.jsonl'),
      `${JSON.stringify({ seq: 0, type: 'status', status: 'running' })}\n`,
    );
    const [lost] = await new LiveRuns(dir).list();
    expect(lost!.status).toBe('cancelled');
    expect(lost!.messages.at(-1)).toMatchObject({ seq: 1, reason: /session that played it ended/ });
  });

  it('is on by default under the home folder; SYMPHONY_LIVE=off turns it off', () => {
    expect(liveRoot({})).toMatch(/[.]symphony[/\\]live$/);
    expect(liveRoot({ SYMPHONY_LIVE_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(liveRoot({ SYMPHONY_LIVE: 'off' })).toBeUndefined();
  });

  it('removes week-old folders whose process is gone, and keeps the rest', async () => {
    const dir = root();
    const old = join(dir, 'old');
    const mine = join(dir, 'mine');
    for (const [d, pid] of [
      [old, 2 ** 22 + 12345],
      [mine, process.pid],
    ] as const) {
      mkdirSync(d);
      writeFileSync(join(d, 'meta.json'), JSON.stringify({ pid }));
      const t = new Date(Date.now() - 8 * 24 * 3600_000);
      utimesSync(d, t, t);
    }
    await pruneLive(dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });
});
