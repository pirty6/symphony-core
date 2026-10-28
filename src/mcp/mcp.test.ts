import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpHttpHandler } from './http.js';
import { RunManager, type RunView } from './runs.js';
import { createSymphonyServer } from './server.js';

const workspace = mkdtempSync(join(tmpdir(), 'symphony-mcp-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));
const env = { SYMPHONY_MCP: 'off' } as NodeJS.ProcessEnv;
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
      'answer_stuck',
      'get_run',
      'list_patterns',
      'maestro',
      'run_pattern',
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
    expect(view.result).toContain('### answer');
    expect(view.savedTo).toContain(join(workspace, '.symphony', 'runs'));
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
    expect(await settle(client, body.run_id)).toMatchObject({ outcome: 'success' });
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
      (go.waitingFor as unknown as { shows: { composed: { pattern: string; steps: string[] } } })
        .shows.composed,
    ).toMatchObject({ pattern: 'fix', steps: expect.arrayContaining(['apply: Edit']) });
    await call(client, 'answer_approval', { run_id: body.run_id, approved: true });
    const next = await settle(client, body.run_id);
    expect(next.chain).toHaveLength(2);
    expect(next.pattern).toBe('fix');
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
