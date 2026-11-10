import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpHttpHandler } from './http.js';
import { LiveRuns } from '../runtime/live.js';
import { RunManager, usageOf, type RunView } from './runs.js';
import { createSymphonyServer } from './server.js';

const workspace = mkdtempSync(join(tmpdir(), 'symphony-mcp-'));
// Patterns that edit start from a git snapshot of the workspace.
execFileSync('git', ['init', '-q'], { cwd: workspace });
// fix runs the tests before it edits: a slow suite keeps the composed run going until it is stopped.
writeFileSync(
  join(workspace, 'package.json'),
  JSON.stringify({ scripts: { test: 'node -e "setTimeout(() => {}, 30000)"' } }),
);
// Where the chat's runs are published for the studio (src/runtime/live.ts).
const live = mkdtempSync(join(tmpdir(), 'symphony-mcp-live-'));
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(live, { recursive: true, force: true });
});
// Symphony's files for the workspace: outside it, here (src/runtime/state.ts).
const home = join(live, 'home');
const env = {
  SYMPHONY_MCP: 'off',
  SYMPHONY_LIVE_DIR: live,
  SYMPHONY_HOME: home,
  SYMPHONY_STATE: 'home',
} as NodeJS.ProcessEnv;
const manager = (editsAllowed = true) =>
  new RunManager({ workspace: async () => workspace, repoRoot: workspace, env, editsAllowed });

async function connect(runs: RunManager): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createSymphonyServer(runs).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as Result;
  return { ...r, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
}

/** Poll get_run until the run needs a human or ends, the way an agent would. */
async function settle(client: Client, runId: string): Promise<RunView> {
  for (let i = 0; i < 40; i++) {
    const { body } = await call(client, 'get_run', { run_id: runId, wait_seconds: 5 });
    if (body.waitingFor || body.outcome) return body as RunView;
  }
  throw new Error('run did not settle');
}

describe('Symphony MCP server', () => {
  it('lists the patterns with their inputs and whether they edit files', async () => {
    const client = await connect(manager());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      'answer_approval',
      'answer_overtime',
      'answer_stuck',
      'get_run',
      'list_patterns',
      'maestro',
      'run_pattern',
      'set_auto_approve',
      'stop_run',
    ]);
    const { body } = await call(client, 'list_patterns');
    const byName = Object.fromEntries((body as { name: string }[]).map((p) => [p.name, p]));
    expect(byName.fix).toMatchObject({
      requiredInputs: ['issue'],
      editsFiles: true,
      available: true,
    });
    expect(byName.investigate).toMatchObject({ editsFiles: false, available: true });
    expect(byName.refactor).toMatchObject({ editsFiles: true });
    expect(byName.implement).toMatchObject({ editsFiles: true });
    expect(byName.hangman).toBeUndefined();
  });

  it('runs a pattern in the background; get_run reports the result when it ends', async () => {
    const client = await connect(manager());
    const started = await call(client, 'run_pattern', {
      pattern: 'investigate',
      inputs: { question: 'Where are AI responses validated before they change state, and why?' },
      provider: 'scripted',
      auto_approve: true,
    });
    expect(started.body.run_id).toMatch(/^run-/);
    const view = await settle(client, started.body.run_id);
    expect(view).toMatchObject({ pattern: 'investigate', outcome: 'success' });
    expect(view.result).toMatch(/^### summary\n\n## In short/);
    expect(view.result).toContain('### handoff');
    // Saved on this machine, outside the workspace: never in its git status.
    expect(view.savedTo).toContain(join(home, 'workspaces'));
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: workspace }).toString(),
    ).not.toMatch(/[.]symphony/);
    // The studio sees the chat's run, and follows it to the end.
    const studio = new LiveRuns(live);
    const seen = await studio.get(started.body.run_id);
    expect(seen).toMatchObject({ source: 'chat', workspace });
    expect(seen!.score.pattern).toBe('investigate');
    await seen!.poll();
    expect(seen!.status).toBe('done');
    studio.dispose();
  });

  it('relays approvals through the chat: the plan is shown, the user decides', async () => {
    const client = await connect(manager());
    const { body } = await call(client, 'run_pattern', {
      pattern: 'fix',
      inputs: { issue: 'Page 2 repeats the last item of page 1' },
      provider: 'scripted',
    });
    const waiting = await settle(client, body.run_id);
    expect(waiting.waitingFor).toMatchObject({ kind: 'approval', step: 'Approve plan' });
    expect(Object.keys((waiting.waitingFor as { shows: object }).shows)).toEqual([
      'rootCause',
      'rulings',
      'files',
      'plan',
    ]);
    await call(client, 'answer_approval', { run_id: body.run_id, approved: true });
    const done = await settle(client, body.run_id);
    expect(done).toMatchObject({ outcome: 'success' });
    // The gate's wait splits where the chat first got the question: asked → shown → answered.
    const saved = JSON.parse(readFileSync(done.savedTo!, 'utf8')) as {
      performance: { steps: { kind: string; at?: string; approval?: Record<string, string> }[] };
    };
    const gate = saved.performance.steps.find((st) => st.kind === 'approval')!;
    expect(gate.approval).toMatchObject({ by: 'mcp' });
    const { askedAt, shownAt } = gate.approval!;
    expect(askedAt! <= shownAt! && shownAt! <= gate.at!).toBe(true);
    const again = await call(client, 'answer_approval', { run_id: body.run_id, approved: true });
    expect(again.isError).toBe(true);
    expect(again.body).toMatch(/no approval is pending/);
  });

  it('the maestro composes, waits for the go, then get_run follows the composed run', async () => {
    const client = await connect(manager());
    const { body } = await call(client, 'maestro', {
      request: 'Fix the flaky login test that fails on CI',
      provider: 'scripted',
    });
    const go = await settle(client, body.run_id);
    expect(go).toMatchObject({
      pattern: 'maestro',
      waitingFor: { kind: 'approval', step: 'Go-gate' },
    });
    // The chat can show what was composed before saying go.
    expect(
      (go.waitingFor as unknown as { shows: { composed: Record<string, unknown> } }).shows.composed,
    ).toMatchObject({
      pattern: 'fix',
      // The tested pattern, tailored: a step count and what changed, not every step again.
      kind: 'tailored',
      summary: expect.stringMatching(/^fix: the tested library pattern \(\d+ steps/),
      stepCount: expect.any(Number),
      adaptation: { initial: { maxAttempts: 2 } },
      requirements: [expect.stringMatching(/^R1: \w+ — /)],
    });
    await call(client, 'answer_approval', { run_id: body.run_id, approved: true });
    // The composed fix is running its tests (slow on purpose): follow it without waiting.
    let next = (await call(client, 'get_run', { run_id: body.run_id, wait_seconds: 0 })).body;
    for (let i = 0; i < 50 && next.pattern !== 'fix'; i++) {
      await new Promise((done) => setTimeout(done, 50));
      next = (await call(client, 'get_run', { run_id: body.run_id, wait_seconds: 0 })).body;
    }
    expect(next.chain).toHaveLength(2);
    expect(next.pattern).toBe('fix');
    // Stopping by the maestro's id stops the composed run, and says so once it has ended.
    const stopped = await call(client, 'stop_run', { run_id: body.run_id });
    expect(stopped.body).toMatchObject({ pattern: 'fix', status: 'cancelled' });
  });

  it('auto-approve mid-run: the waiting go-gate answers itself, and the composed run keeps it', async () => {
    const client = await connect(manager());
    const { body } = await call(client, 'maestro', {
      request: 'Fix the flaky login test that fails on CI',
      provider: 'scripted',
    });
    const go = await settle(client, body.run_id);
    expect(go.waitingFor).toMatchObject({ kind: 'approval', step: 'Go-gate' });
    expect(go).not.toHaveProperty('autoApprove');
    const on = await call(client, 'set_auto_approve', { run_id: body.run_id, on: true });
    expect(on.body).toMatchObject({ autoApprove: true });
    // No answer_approval: the go-gate answered itself and the composed fix started, auto-approving.
    let next = (await call(client, 'get_run', { run_id: body.run_id, wait_seconds: 0 })).body;
    for (let i = 0; i < 100 && next.pattern !== 'fix'; i++) {
      await new Promise((done) => setTimeout(done, 50));
      next = (await call(client, 'get_run', { run_id: body.run_id, wait_seconds: 0 })).body;
    }
    expect(next).toMatchObject({ pattern: 'fix', autoApprove: true });
    await call(client, 'stop_run', { run_id: body.run_id });
  });

  it('a chat may name another folder to work in (e.g. a separate worktree); remote callers may not', async () => {
    const other = mkdtempSync(join(tmpdir(), 'symphony-mcp-other-'));
    try {
      const client = await connect(manager());
      const started = await call(client, 'run_pattern', {
        pattern: 'investigate',
        inputs: { question: 'q' },
        provider: 'scripted',
        auto_approve: true,
        workspace: other,
      });
      const view = await settle(client, started.body.run_id);
      expect(view.outcome).toBe('success');
      // Saved under that folder's own Symphony folder, outside it, not the open workspace's.
      expect(view.savedTo).toMatch(/workspaces[/\\]symphony-mcp-other-/);
      expect(existsSync(join(other, '.symphony'))).toBe(false);
      for (const bad of ['relative/dir', join(other, 'missing')])
        expect(
          (
            await call(client, 'run_pattern', {
              pattern: 'investigate',
              inputs: { question: 'q' },
              provider: 'scripted',
              workspace: bad,
            })
          ).isError,
        ).toBe(true);
      const remote = await connect(manager(false));
      const refused = await call(remote, 'run_pattern', {
        pattern: 'investigate',
        inputs: { question: 'q' },
        provider: 'scripted',
        workspace: other,
      });
      expect(refused.body).toMatch(/only be chosen from a local chat/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('remote callers may not run patterns that edit files', async () => {
    const client = await connect(manager(false));
    const fix = await call(client, 'run_pattern', { pattern: 'fix', inputs: { issue: 'x' } });
    expect(fix.isError).toBe(true);
    expect(fix.body).toMatch(/edits files, which remote callers may not do/);
    const chained = await call(client, 'run_pattern', {
      pattern: 'investigate',
      inputs: { question: 'q' },
      chain: ['fix'],
    });
    expect(chained.body).toMatch(/'fix' edits files/);
    const { body } = await call(client, 'list_patterns');
    expect(
      (body as { name: string; available: boolean }[]).find((p) => p.name === 'fix')!.available,
    ).toBe(false);
  });
});

/** The id of a process that has ended. */
const endedPid = () => spawnSync(process.execPath, ['-e', '']).pid;

describe('a chat whose Symphony server was restarted', () => {
  it('picks its run up from the last checkpoint, by the id it knows', async () => {
    const first = await connect(manager());
    const { body } = await call(first, 'run_pattern', {
      pattern: 'fix',
      inputs: { issue: 'Page 2 repeats the last item of page 1' },
      provider: 'scripted',
    });
    const id = body.run_id as string;
    const waiting = await settle(first, id);
    expect(waiting.waitingFor).toMatchObject({ kind: 'approval', step: 'Approve plan' });
    // The server ends (a restarted chat ends it): its process is gone, the run was mid-way.
    await call(first, 'stop_run', { run_id: id });
    const metaFile = join(live, id, 'meta.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { pid: number };
    writeFileSync(metaFile, JSON.stringify({ ...meta, pid: endedPid() }));
    const second = await connect(manager());
    const resumed = await settle(second, id);
    expect(resumed.runId).not.toBe(id);
    expect(resumed.note).toMatch(/resumed here from its last checkpoint/);
    expect(resumed.waitingFor).toMatchObject({ kind: 'approval', step: 'Approve plan' });
    const resumeFile = JSON.parse(readFileSync(join(live, id, 'resume.json'), 'utf8')) as object;
    expect(resumeFile).toMatchObject({ next: resumed.runId, provider: 'scripted' });
    // The chat goes on with the id it knows.
    await call(second, 'answer_approval', { run_id: id, approved: true });
    expect(await settle(second, id)).toMatchObject({ outcome: 'success' });
    // Another server never plays it twice; unknown ids and paths are unknown runs.
    const third = await connect(manager());
    const twice = await call(third, 'get_run', { run_id: id, wait_seconds: 0 });
    expect(twice.isError).toBe(true);
    expect(twice.body).toMatch(/played by another Symphony process/);
    for (const unknown of ['run-zzz-0', '../home']) {
      const r = await call(third, 'get_run', { run_id: unknown, wait_seconds: 0 });
      expect(r.body).toMatch(/unknown run/);
    }
  });
});

describe('remote (read-only) runs', () => {
  it('play every AI step with read-only permissions', async () => {
    const { readOnly } = await import('./runs.js');
    const seen: string[] = [];
    const inner = {
      name: 'x',
      runAgent: async (req: { pause: { role: string } }) => {
        seen.push(req.pause.role);
        return { result: {}, transcript: { provider: 'x', prompt: '', output: '', toolCalls: [] } };
      },
      draft: async () => ({
        result: {},
        transcript: { provider: 'x', prompt: '', output: '', toolCalls: [] },
      }),
    };
    await readOnly(inner as never).runAgent({ pause: { role: 'executor' } } as never);
    expect(seen).toEqual(['assessor']);
  });
});

describe('Symphony MCP over HTTP (Copilot Studio)', () => {
  const key = 'k'.repeat(24);
  let server: Server;
  let base: string;
  afterAll(() => server?.close());

  it('needs the API key, then serves the same tools', async () => {
    server = createServer(
      (req, res) => void mcpHttpHandler({ runs: manager(false), apiKey: key })(req, res),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const anonymous = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(anonymous.status).toBe(401);
    const wrong = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'x-api-key': 'nope' },
      body: '{}',
    });
    expect(wrong.status).toBe(401);

    const variants: Record<string, string>[] = [
      { 'x-api-key': key },
      { authorization: `Bearer ${key}` },
    ];
    for (const headers of variants) {
      const client = new Client({ name: 'studio', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers },
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('maestro');
      const { body } = await call(client, 'list_patterns');
      expect((body as { name: string }[]).map((p) => p.name)).toContain('investigate');
      await client.close();
    }
    expect(() => mcpHttpHandler({ runs: manager(), apiKey: 'short' })).toThrow(/16 characters/);
  });
});

const usage = (input: number, premium: number, calls = 1) => ({
  calls,
  inputTokens: input,
  outputTokens: input / 10,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  premiumRequests: premium,
});
const step = (nodeId: string, input: number, premium: number, extra: object = {}) =>
  ({
    nodeId,
    kind: 'agent',
    transcript: {
      provider: 'copilot',
      prompt: '',
      output: '',
      toolCalls: [],
      usage: usage(input, premium),
    },
    ...extra,
  }) as never;

describe('get_run usage', () => {
  it('shows the costliest steps, rejected answers, and compose vs perform for a chain', () => {
    const maestroRun = {
      pattern: 'maestro',
      steps: [step('propose', 90_000, 3), step('classify', 5000, 1)],
    };
    const rejectedAttempt = {
      errors: ['updates arrived as text'],
      transcript: {
        provider: 'copilot',
        prompt: '',
        output: '',
        toolCalls: [{ name: 'submit_result', args: { updates: '{"a":1' }, ok: false }],
        usage: usage(20_000, 2),
      },
    };
    const fixRun = {
      pattern: 'fix',
      steps: [
        step('diagnose', 40_000, 2, { attempts: [rejectedAttempt] }),
        step('apply', 10_000, 1),
      ],
    };
    const u = usageOf(fixRun, [maestroRun, fixRun]);
    expect(u.premiumRequests).toBe(5);
    expect(Object.keys(u.byStep)).toEqual(['diagnose', 'apply']);
    expect(u.byStep.diagnose).toMatch(/^80% of the cost: 60k in .* 2 calls · 4 premium requests$/);
    expect(u.rejected).toMatch(
      /^1 attempts \(20k in .* 2 premium requests\) · 1 answers sent updates as text$/,
    );
    expect(u.chain).toEqual({
      compose: expect.stringMatching(/^95k in .* 4 premium requests$/),
      perform: expect.stringMatching(/^70k in .* 5 premium requests$/),
      premiumRequests: 9,
    });
    // A run on its own: no chain split.
    expect(usageOf(maestroRun, [maestroRun]).chain).toBeUndefined();
  });
  it('shows model time by phase, in-session corrections and the waits for a person', () => {
    const tagged = step('skeptic', 1000, 1, {
      transcript: {
        provider: 'copilot',
        prompt: '',
        output: '',
        toolCalls: [],
        startedAt: '2026-11-04T05:00:00.000Z',
        completedAt: '2026-11-04T05:00:30.000Z',
        calls: [
          {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            ms: 20_000,
            submits: ['rejected'],
          },
          { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, ms: 5000, submits: ['recorded'] },
          { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, ms: 5000 },
        ],
      },
    });
    const gate = {
      nodeId: 'gate',
      kind: 'approval',
      at: '2026-11-04T05:01:30.000Z',
      approval: {
        approved: true,
        by: 'mcp',
        askedAt: '2026-11-04T05:00:30.000Z',
        shownAt: '2026-11-04T05:01:00.000Z',
      },
    } as never;
    const run = { pattern: 'maestro', steps: [tagged, gate] };
    const u = usageOf(run, [run]);
    expect(u.modelTime).toBe('answer 20s (67%) · correction 5s (17%) · closing 5s (17%)');
    expect(u.inSessionCorrections).toBe(1);
    expect(u.waits).toEqual(['gate 60s (shown after 30s, decided in 30s)']);
  });
});
