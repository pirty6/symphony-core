// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fix, hangman } from '../../../src/patterns/index.js';
import { compileScore } from '../../../src/core/compile.js';
import { Run } from '../../../src/runtime/driver.js';
import { publishLive } from '../../../src/runtime/live.js';
import { ScriptedProvider } from '../../../src/runtime/scripted-provider.js';
import { VisitorAccounts } from '../../../src/runtime/accounts.js';
import { createApi } from './api.ts';

const root = mkdtempSync(join(tmpdir(), 'symphony-api-'));
// Runs a chat plays in another process are published here (src/runtime/live.ts).
const live = mkdtempSync(join(tmpdir(), 'symphony-api-live-'));
let server: Server;
let base = '';

beforeAll(async () => {
  const api = createApi({
    repoRoot: root,
    importer: (f) => import(pathToFileURL(f).href),
    env: { SYMPHONY_LIVE_DIR: live },
  });
  server = createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(live, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const data = (p: typeof fix) => {
  const { demo: _demo, ...rest } = p;
  return rest;
};

/** Read an SSE stream, calling onMessage for each data payload, until the server closes it. */
async function readSse(
  res: Response,
  onMessage?: (m: Record<string, unknown>) => void,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const msg = JSON.parse(line.slice(6)) as Record<string, unknown>;
      out.push(msg);
      onMessage?.(msg);
    }
  }
  return out;
}

type Message = Record<string, unknown>;
type SavedRun = { file: string; pattern: string; outcome: string };
type NextRun = {
  runId: string;
  pattern: { name: string };
  context: { request: string; testCommand: string };
};

const SAVED_RUN_WAIT = { timeout: 5_000, interval: 20 };

const isStatus = (m: Message, status: string) => m.type === 'status' && m.status === status;
const isPickProposal = (m: Message) =>
  isStatus(m, 'paused') && m.nodeId === 'pick' && m.phase === 'after';
const savedRuns = async () => (await (await fetch(`${base}/api/saved`)).json()) as SavedRun[];

/** Polls the saved runs until one matches, and returns it. */
const waitForSavedRun = (matches: (run: SavedRun) => boolean) =>
  vi.waitFor(async () => {
    const run = (await savedRuns()).find(matches);
    expect(run).toBeDefined();
    return run!;
  }, SAVED_RUN_WAIT);

const control = (id: string, body: unknown) => post(`/api/runs/${id}/control`, body);

/** Leaves step mode once the word is picked, steps through every other pause, and answers every approval. */
function stepThroughRun(id: string) {
  return (m: Message) => {
    if (isPickProposal(m))
      void control(id, { action: 'stepMode', on: false }).then(() =>
        control(id, { action: 'resume' }),
      );
    else if (isStatus(m, 'paused')) void control(id, { action: 'step' });
    if (isStatus(m, 'awaiting-approval')) void post(`/api/runs/${id}/approval`, { scripted: true });
  };
}

/** Stops the run as soon as it waits for an approval. */
function stopAtApproval(id: string) {
  return (m: Message) => {
    if (isStatus(m, 'awaiting-approval')) void control(id, { action: 'stop' });
  };
}

/** Approves the first approval the stream shows, from the studio; `answered` tells whether it did. */
function approveOnce(id: string) {
  const answer = {
    answered: false,
    onMessage: (m: Message) => {
      if (answer.answered || !isStatus(m, 'awaiting-approval')) return;
      answer.answered = true;
      void post(`/api/runs/${id}/approval`, { approved: true });
    },
  };
  return answer;
}

/** Follows a run and every run it hands over to, and returns each hand-over in order. */
async function followHandOvers(firstId: string): Promise<NextRun[]> {
  const handOvers: NextRun[] = [];
  let id = firstId;
  for (;;) {
    const next = (await readSse(await fetch(`${base}/api/runs/${id}/events`))).find(
      (m) => m.type === 'next',
    ) as NextRun | undefined;
    if (!next) return handOvers;
    handOvers.push(next);
    id = next.runId;
  }
}

// Stands in for `copilot login`: a device code, then (a moment later) the login recorded in its Copilot home.
const FAKE_COPILOT_LOGIN = `process.stdout.write('To authenticate, visit https://github.com/login/device and enter code WXYZ-9876.\\n');
setTimeout(() => { require('fs').writeFileSync(require('path').join(process.env.COPILOT_HOME, 'config.json'), '{ "lastLoggedInUser": { "login": "octocat" } }'); process.exit(0) }, 30)`;

// What a test made that must go once it ends, pass or fail: undone last-made first.
const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((clean) => clean());
});

/** Serves the api as if every request came from another machine on the network; returns its base URL. */
async function serveAsRemote(api: ReturnType<typeof createApi>): Promise<string> {
  const remote = createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '198.168.10.7' });
    void api.handle(req, res);
  });
  await new Promise<void>((r) => remote.listen(0, r));
  cleanups.push(() => remote.close());
  return `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
}

/** A throwaway folder, removed after the test. */
function scratchFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

describe('studio api', () => {
  it('your local AI is a choice only when a model server is set', async () => {
    expect(await (await fetch(`${base}/api/local/status`)).json()).toEqual({ configured: false });
    const refused = await post('/api/runs', { pattern: data(hangman), provider: 'local' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toMatch(/SYMPHONY_MODEL_URL/);
  });

  it('lists the pattern library with graphs and demo inputs', async () => {
    const list = (await (await fetch(`${base}/api/patterns`)).json()) as {
      name: string;
      graph: { nodes: unknown[] };
      demo?: { context: unknown };
    }[];
    const fixItem = list.find((p) => p.name === 'fix')!;
    expect(fixItem.graph.nodes.length).toBe(fix.nodes.length);
    expect(fixItem.demo?.context).toEqual(fix.demo!.context);
  });

  it('runs a pattern, streams events, saves and replays it', async () => {
    const start = (await (
      await post('/api/runs', {
        pattern: data(fix),
        goal: 'fix it',
        context: fix.demo!.context,
        provider: 'scripted',
        autoApprove: true,
      })
    ).json()) as { runId: string };
    const msgs = await readSse(await fetch(`${base}/api/runs/${start.runId}/events`));
    const types = new Set(msgs.map((m) => m.type));
    // 'part': the pillar lenses play as the parts of one step.
    expect(types).toEqual(new Set(['status', 'engine', 'provider', 'performance', 'part']));
    expect(msgs.at(-1)).toMatchObject({ type: 'status', status: 'done' });
    const saved = (await (await fetch(`${base}/api/saved`)).json()) as {
      file: string;
      durationMs: number;
    }[];
    expect(saved).toHaveLength(1);
    // Timed, for the studio's estimate of the next run of this pattern.
    expect(saved[0]!.durationMs).toBeGreaterThanOrEqual(0);
    const path = encodeURIComponent(saved[0]!.file);
    const open = async () =>
      (await (await fetch(`${base}/api/saved/file?path=${path}`)).json()) as {
        reproduced: boolean | null;
        issues: string[];
      };
    // Opening answers at once; the replay verdict is in already (checked when the run ended) or on its way.
    expect([true, null]).toContain((await open()).reproduced);
    expect(await (await fetch(`${base}/api/saved/check?path=${path}`)).json()).toEqual({
      reproduced: true,
      issues: [],
    });
    // Once checked, every open has the verdict.
    expect(await open()).toMatchObject({ reproduced: true, issues: [] });
    expect((await fetch(`${base}/api/saved/check?path=..%2F..%2Fpackage.json`)).status).toBe(400);
  });

  it("cleans up saved runs on request (today's runs are kept)", async () => {
    const report = await (await post('/api/saved/prune', { dryRun: true })).json();
    expect(report).toEqual({ deleted: [], compacted: [], scratch: [], freed: 0 });
    expect((await (await fetch(`${base}/api/saved`)).json()) as unknown[]).toHaveLength(1);
  });

  it('forks a saved run from a step and refuses to resume a finished one', async () => {
    const [first] = (await (await fetch(`${base}/api/saved`)).json()) as { file: string }[];
    const settings = { provider: 'scripted', autoApprove: true, stepMode: false, breakpoints: [] };
    const refused = await post('/api/runs/continue', {
      file: first!.file,
      kind: 'resumed',
      ...settings,
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /already ended \(success\)/,
    );
    const bad = await post('/api/runs/continue', {
      file: '../../etc/passwd',
      kind: 'forked',
      atStep: 2,
      ...settings,
    });
    expect(bad.status).toBe(400);
    const fork = (await (
      await post('/api/runs/continue', {
        file: first!.file,
        kind: 'forked',
        atStep: 2,
        ...settings,
      })
    ).json()) as { runId: string };
    const msgs = await readSse(await fetch(`${base}/api/runs/${fork.runId}/events`));
    const done = msgs.find((m) => m.type === 'performance') as {
      performance: { outcome: string; basedOn: unknown };
      savedTo: string;
    };
    expect(done.performance).toMatchObject({
      outcome: 'success',
      basedOn: { kind: 'forked', from: first!.file, throughStep: 1 },
    });
    const saved = (await (await fetch(`${base}/api/saved`)).json()) as { file: string }[];
    const forked = saved.find((r) => r.file !== first!.file)!;
    const check = (await (
      await fetch(`${base}/api/saved/check?path=${encodeURIComponent(forked.file)}`)
    ).json()) as { reproduced: boolean };
    expect(check.reproduced).toBe(true);
  });

  it('deletes one saved run, but not one still playing or outside the store', async () => {
    const start = (await (
      await post('/api/runs', { pattern: data(hangman), provider: 'scripted' })
    ).json()) as { runId: string };
    // It waits for a guess, with a checkpoint saved.
    const playing = await waitForSavedRun((r) => r.pattern === 'hangman');
    // Resuming a run this server is still playing follows it: no second copy.
    const settings = { provider: 'scripted', autoApprove: false, stepMode: false, breakpoints: [] };
    const again = (await (
      await post('/api/runs/continue', { file: playing.file, kind: 'resumed', ...settings })
    ).json()) as { runId: string };
    expect(again.runId).toBe(start.runId);
    const live = (await (await fetch(`${base}/api/runs`)).json()) as {
      id: string;
      pattern: string;
      status: string;
      startedAt: string;
      waitingSince?: string;
    }[];
    expect(
      live.filter(
        (r) => r.pattern === 'hangman' && !['done', 'failed', 'cancelled'].includes(r.status),
      ),
    ).toHaveLength(1);
    // Timed from when it started here; the wait for the guess is told apart.
    const mine = live.find((r) => r.id === start.runId)!;
    expect(mine).toMatchObject({ status: 'awaiting-approval', demo: true, waitMs: 0 });
    expect(Date.parse(mine.waitingSince!)).toBeGreaterThanOrEqual(Date.parse(mine.startedAt));
    const busy = await post('/api/saved/delete', { path: playing.file });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toMatch(/still playing/);
    expect((await post('/api/saved/delete', { path: '../../package.json' })).status).toBe(400);
    await post(`/api/runs/${start.runId}/control`, { action: 'stop' });
    await waitForSavedRun((r) => r.file === playing.file && r.outcome === 'cancelled');
    const before = ((await (await fetch(`${base}/api/saved`)).json()) as unknown[]).length;
    const done = await post('/api/saved/delete', { path: playing.file });
    expect(done.status).toBe(200);
    const after = (await (await fetch(`${base}/api/saved`)).json()) as { file: string }[];
    expect(after).toHaveLength(before - 1);
    expect(after.some((r) => r.file === playing.file)).toBe(false);
    expect((await post('/api/saved/delete', { path: playing.file })).status).toBe(404);
  });

  it('pauses in step mode and accepts human approvals', async () => {
    const start = (await (
      await post('/api/runs', { pattern: data(hangman), provider: 'scripted', stepMode: true })
    ).json()) as { runId: string };
    const id = start.runId;
    const msgs = await readSse(await fetch(`${base}/api/runs/${id}/events`), stepThroughRun(id));
    expect(msgs.find(isPickProposal)).toMatchObject({ proposed: { updates: { word: 'planet' } } });
    expect(msgs.filter((m) => isStatus(m, 'awaiting-approval'))).toHaveLength(7);
    expect(msgs.find((m) => m.type === 'performance')).toMatchObject({
      performance: { outcome: 'success' },
    });
  });

  it('stops a running flow', async () => {
    const start = (await (
      await post('/api/runs', { pattern: data(hangman), provider: 'scripted' })
    ).json()) as { runId: string };
    const msgs = await readSse(
      await fetch(`${base}/api/runs/${start.runId}/events`),
      stopAtApproval(start.runId),
    );
    expect(msgs.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('rejects invalid patterns and unknown runs', async () => {
    const bad = await post('/api/runs', {
      pattern: { ...data(fix), nodes: [] },
      provider: 'scripted',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    expect((await post('/api/runs/nope/control', { action: 'pause' })).status).toBe(404);
    expect((await post('/api/runs', { pattern: data(fix), provider: 'gpt' })).status).toBe(400);
  });

  it('validates, generates TypeScript and saves drafts into the library', async () => {
    expect(await (await post('/api/validate', { pattern: data(fix) })).json()).toEqual({
      errors: [],
      warnings: [],
    });
    const ts = (await (await post('/api/typescript', { pattern: data(fix) })).json()) as {
      source: string;
    };
    expect(ts.source).toContain('export const fix: Pattern');
    const msgs = await readSse(
      await post('/api/draft', { request: 'Upgrade dependencies safely', provider: 'scripted' }),
    );
    const done = msgs.find((m) => m.type === 'done') as { pattern: { name: string } };
    expect(done.pattern.name).toBe('upgrade-dependencies-safely');
    expect((await post('/api/patterns', { pattern: done.pattern })).status).toBe(200);
    const list = (await (await fetch(`${base}/api/patterns`)).json()) as {
      name: string;
      source: string;
    }[];
    expect(list.find((p) => p.name === 'upgrade-dependencies-safely')?.source).toBe('draft');
  });

  it('answers stuck steps only with retry or stop, and only when one is waiting', async () => {
    const start = (await (
      await post('/api/runs', {
        pattern: data(fix),
        goal: 'g',
        context: fix.demo!.context,
        provider: 'scripted',
        autoApprove: true,
      })
    ).json()) as { runId: string };
    await readSse(await fetch(`${base}/api/runs/${start.runId}/events`));
    expect((await post(`/api/runs/${start.runId}/recovery`, { action: 'maybe' })).status).toBe(400);
    const none = await post(`/api/runs/${start.runId}/recovery`, { action: 'retry', hint: 'x' });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toMatch(/no stuck step is waiting/);
  });

  it('chains a second pattern after a successful run, with what the first found', async () => {
    const { investigate } = await import('../../../src/patterns/index.js');
    const start = (await (
      await post('/api/runs', {
        pattern: data(investigate),
        goal: 'g',
        context: investigate.demo!.context,
        provider: 'scripted',
        autoApprove: true,
        chain: ['fix'],
      })
    ).json()) as { runId: string };
    const first = await readSse(await fetch(`${base}/api/runs/${start.runId}/events`));
    const next = first.find((m) => m.type === 'next') as {
      runId: string;
      pattern: { name: string };
      context: { issue: string };
    };
    expect(next.pattern.name).toBe('fix');
    expect(next.context.issue).toContain('What the investigate run found');
    const second = await readSse(await fetch(`${base}/api/runs/${next.runId}/events`));
    expect(second.at(-1)).toMatchObject({ type: 'status', status: 'done' });
    expect(second.some((m) => m.type === 'next')).toBe(false);
  });

  it('plays each picked backlog item as its own run, one after another', async () => {
    const { backlog } = await import('../../../src/patterns/index.js');
    const items = backlog.demo!.agents!.extract!({}, 1).updates!.items as string[];
    const start = (await (
      await post('/api/runs', {
        pattern: data(backlog),
        goal: 'g',
        context: { source: 'doc.md', testCommand: 'npm test' },
        provider: 'scripted',
        autoApprove: true,
      })
    ).json()) as { runId: string };
    const handOvers = await followHandOvers(start.runId);
    expect(handOvers.map((next) => next.pattern.name)).toEqual(items.map(() => 'implement'));
    expect(handOvers.map((next) => next.context.testCommand)).toEqual(items.map(() => 'npm test'));
    expect(handOvers.map((next) => next.context.request)).toEqual(items);
  });

  it('lists optional patterns only when asked (default: SYMPHONY_EXTRAS, off here)', async () => {
    const names = async (q: string) =>
      (await (await fetch(`${base}/api/patterns${q}`)).json()) as {
        name: string;
        source: string;
      }[];
    expect((await names('')).some((p) => p.name === 'metaphor')).toBe(false);
    const on = await names('?extras=on');
    expect(on.filter((p) => p.source === 'extra').map((p) => p.name)).toEqual([
      'metaphor',
      'storm-in-between',
    ]);
    expect((await names('?extras=off')).some((p) => p.source === 'extra')).toBe(false);
  });

  it('refuses cross-site and non-JSON POSTs', async () => {
    const plain = await fetch(`${base}/api/patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(plain.status).toBe(403);
    const cross = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ pattern: data(fix), provider: 'scripted' }),
    });
    expect(cross.status).toBe(403);
  });
});

describe('runs a chat plays (the MCP server, another process)', () => {
  it('are listed, streamed live and answered from the studio', async () => {
    // Played by "another process": a run published to the shared folder, never started here.
    const run = new Run({
      score: compileScore(fix, { context: fix.demo!.context!, generatedAt: 't' }),
      provider: ScriptedProvider.forPattern(fix),
      demo: fix.demo,
      autoApprove: false,
      clock: () => 't',
    });
    const stop = await publishLive(run, { source: 'chat', workspace: '/elsewhere' }, live);
    const done = run.start();
    const listed = async () =>
      (
        (await (await fetch(`${base}/api/runs`)).json()) as {
          id: string;
          source?: string;
          status: string;
        }[]
      ).find((r) => r.id === run.id);
    expect(await listed()).toMatchObject({ source: 'chat' });
    const one = (await (await fetch(`${base}/api/runs/${run.id}`)).json()) as {
      score: { pattern: string };
    };
    expect(one.score.pattern).toBe('fix');
    // The stream answers the approval from the studio, then follows the run to its end.
    const studio = approveOnce(run.id);
    const msgs = await readSse(await fetch(`${base}/api/runs/${run.id}/events`), studio.onMessage);
    await done;
    expect(studio.answered).toBe(true);
    expect(msgs.at(-1)).toMatchObject({ type: 'status', status: 'done' });
    expect(run.status).toBe('done');
    stop();
    // About 1 s here (the shared files are polled every 400 ms); slower CI runners need more.
  }, 15_000);
});

describe('sign-ins only here (SYMPHONY_SIGNINS=here)', () => {
  it('a browser on another machine never uses your Copilot account, and sees your model server', async () => {
    const api = createApi({
      repoRoot: root,
      importer: (f) => import(pathToFileURL(f).href),
      env: {
        SYMPHONY_LIVE_DIR: live,
        SYMPHONY_SIGNINS: 'here',
        // A model server that is not there, with fallback on.
        SYMPHONY_MODEL_URL: 'http://127.0.0.1:1/v1',
        SYMPHONY_MODEL_ID: 'm',
        SYMPHONY_MODEL_FALLBACK: 'copilot',
      },
    });
    // Every request seems to come from another machine on the network.
    const remoteBase = await serveAsRemote(api);
    const copilot = (await (await fetch(`${remoteBase}/api/copilot/status`)).json()) as {
      signedIn: boolean;
      message: string;
    };
    expect(copilot.signedIn).toBe(false);
    expect(copilot.message).toMatch(/Sign in with GitHub.*AI: Local/);
    // Your model server: set, and down here (no fallback to Copilot behind its back).
    const local = (await (await fetch(`${remoteBase}/api/local/status`)).json()) as Record<
      string,
      unknown
    >;
    expect(local).toMatchObject({ configured: true, model: 'm', reachable: false });
    expect(local.message).toMatch(/did not answer/);
  });
});

describe('a visitor signs in with its own GitHub for Copilot', () => {
  it('signs in from its browser, gets its own Copilot, and signs out; your account is never used', async () => {
    const home = scratchFolder('symphony-api-accounts-');
    const cli = join(home, 'cli.js');
    writeFileSync(cli, FAKE_COPILOT_LOGIN);
    const api = createApi({
      repoRoot: root,
      importer: (f) => import(pathToFileURL(f).href),
      env: { SYMPHONY_LIVE_DIR: live, SYMPHONY_SIGNINS: 'here' },
      accounts: new VisitorAccounts(join(home, 'accounts'), () => cli, join(home, 'host')),
    });
    const at = await serveAsRemote(api);
    let cookie = '';
    const get = async (path: string) =>
      (await fetch(at + path, { headers: { cookie } })).json() as Promise<Record<string, unknown>>;
    const send = (path: string, body: unknown) =>
      fetch(at + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
    // Not signed in, and your sign-ins are not shared: Copilot is refused, with how to sign in.
    expect(await get('/api/copilot/status')).toMatchObject({
      signedIn: false,
      canSignIn: true,
      message: expect.stringMatching(/Sign in with GitHub/),
    });
    const refused = await send('/api/runs', { pattern: data(hangman), provider: 'copilot' });
    expect(refused.status).toBe(400);
    // Sign in: the code to enter at GitHub, and a cookie only this browser holds.
    const login = await send('/api/account/login', {});
    expect(await login.json()).toEqual({
      url: 'https://github.com/login/device',
      code: 'WXYZ-9876',
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/symphony_account=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict/);
    cookie = setCookie.split(';')[0]!;
    await expect
      .poll(() => get('/api/account'))
      .toMatchObject({ here: false, signedIn: true, login: 'octocat' });
    expect(await get('/api/copilot/status')).toMatchObject({
      signedIn: true,
      login: 'octocat',
      visitor: true,
    });
    // Signed out: back to not signed in.
    await send('/api/account/logout', {});
    expect(await get('/api/account')).toMatchObject({ signedIn: false });
  });

  it('this computer uses its own sign-in, never a visitor one', async () => {
    expect(await (await fetch(`${base}/api/account`)).json()).toEqual({ here: true });
    expect((await post('/api/account/login', {})).status).toBe(400);
  });
});
