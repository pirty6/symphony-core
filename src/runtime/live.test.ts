import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { fix } from '../patterns/index.js';
import { Run, type RunMessage } from './driver.js';
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

const streamedText = (m: RunMessage) =>
  m.type === 'provider' && (m.event.type === 'delta' || m.event.type === 'reasoning');
const text = (ms: readonly RunMessage[]) =>
  ms
    .flatMap((m) => (m.type === 'provider' && m.event.type === 'delta' ? [m.event.text] : []))
    .join('');

describe('live runs: a run another process plays, in the studio', () => {
  it('never writes a secret, even one streamed in pieces', async () => {
    const dir = root();
    // Built at run time: no literal a secret scanner would flag.
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const scripted = ScriptedProvider.forPattern(fix);
    const run = new Run({
      score: compileScore(fix, { context: fix.demo!.context!, generatedAt: 't' }),
      provider: {
        name: 'leaky',
        runAgent: async (req) => {
          for (const piece of ['the key is gh', token.slice(2, 20), token.slice(20), ' ok\n'])
            req.onEvent({ type: 'delta', text: piece });
          req.onEvent({
            type: 'tool-start',
            id: '1',
            name: 'bash',
            args: { command: `echo ${token}` },
          });
          return scripted.runAgent(req);
        },
        draft: () => Promise.reject(new Error('n/a')),
      },
      demo: fix.demo,
      autoApprove: true,
      clock: () => 't',
    });
    const stop = await publishLive(run, { source: 'chat', workspace: '/w' }, dir);
    await run.start();
    stop();
    await new Promise((r) => setTimeout(r, 300));
    const [seen] = await new LiveRuns(dir).list();
    await seen!.poll();
    const file = JSON.stringify(seen!.messages);
    // Read as anyone reading the file would: the streamed pieces joined up.
    const streamed = seen!.messages
      .flatMap((m) => (m.type === 'provider' && m.event.type === 'delta' ? [m.event.text] : []))
      .join('');
    expect(streamed).toContain('the key is [REDACTED:github-token] ok');
    expect(`${file}${streamed}`).not.toContain(token.slice(4, 24));
    expect(file).toContain('echo [REDACTED:github-token]');
    // In memory the run still has what the AI said (it is only kept out of files).
    expect(JSON.stringify(run.messages)).toContain(token.slice(4));
  });

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
    // The file numbers what it holds; streamed text may come in fewer, larger pieces (it is
    // scrubbed across them), everything else is there, in order.
    expect(seen!.messages.map((m) => m.seq)).toEqual(seen!.messages.map((_, i) => i));
    const kinds = (ms: readonly RunMessage[]) =>
      ms.filter((m) => !streamedText(m)).map((m) => (m.type === 'engine' ? m.event.type : m.type));
    expect(kinds(seen!.messages)).toEqual(kinds(run.messages));
    expect(text(seen!.messages)).toBe(text(run.messages));
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
