import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '@github/copilot-sdk';
import type { AgentPause } from '../core/types.js';
import { CopilotProvider, type ClientLike, type SessionLike } from './copilot-provider.js';
import type { ProviderEvent } from './provider.js';

const pause: AgentPause = {
  kind: 'agent',
  pauseId: 'p',
  step: 1,
  nodeId: 'pick',
  role: 'assessor',
  label: 'Pick word',
  directive: 'pick',
  goal: 'play',
  context: {},
  input: {},
  outputSchema: [{ name: 'word', type: 'string' }],
  attempt: 1,
  maxAttempts: 2,
  moveKey: 'm',
};

type Script = (
  cfg: SessionConfig,
  emit: (type: string, data?: unknown) => void,
  s: FakeSession,
) => Promise<void>;

class FakeSession implements SessionLike {
  handlers: ((e: { type: string; data?: unknown }) => void)[] = [];
  aborted = false;
  disconnected = false;
  readonly cfg: SessionConfig;
  readonly script: Script;
  constructor(cfg: SessionConfig, script: Script) {
    this.cfg = cfg;
    this.script = script;
  }
  on(h: (e: { type: string; data?: unknown }) => void) {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }
  emit = (type: string, data?: unknown) => this.handlers.forEach((h) => h({ type, data }));
  async send() {
    void this.script(this.cfg, this.emit, this);
    return 'msg';
  }
  async abort() {
    this.aborted = true;
  }
  async disconnect() {
    this.disconnected = true;
  }
}

function fakeClient(script: Script) {
  const sessions: FakeSession[] = [];
  const client: ClientLike = {
    start: async () => {},
    stop: async () => {},
    createSession: async (cfg) => {
      const s = new FakeSession(cfg, script);
      sessions.push(s);
      return s;
    },
  };
  return { client, sessions };
}

const callTool = async (cfg: SessionConfig, name: string, args: unknown) => {
  const tool = cfg.tools!.find((t) => t.name === name)!;
  return tool.handler!(args, {} as never);
};

describe('CopilotProvider', () => {
  it('streams, enforces read-only and captures submit_result', async () => {
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      emit('assistant.message_delta', { deltaContent: 'Think' });
      const denied = await cfg.onPermissionRequest!({ kind: 'write', fileName: 'x' } as never, {
        sessionId: 's',
      });
      expect(denied).toMatchObject({ kind: 'reject' });
      emit('tool.execution_start', { toolCallId: 't1', toolName: 'submit_result', arguments: {} });
      await callTool(cfg, 'submit_result', {
        updates: { word: 'cat' },
        verdict: { outcome: 'applied' },
      });
      emit('tool.execution_complete', { toolCallId: 't1', success: true });
      emit('assistant.message', { content: 'Done.', model: 'm1' });
      emit('session.idle');
    });
    const events: ProviderEvent[] = [];
    const p = new CopilotProvider({ clientFactory: () => client, model: 'm1' });
    const res = await p.runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    expect(res.result).toEqual({ updates: { word: 'cat' }, verdict: { outcome: 'applied' } });
    expect(res.transcript).toMatchObject({ provider: 'copilot', model: 'm1', output: 'Done.' });
    expect(res.transcript.toolCalls.some((c) => c.denied)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      'delta',
      'permission',
      'tool-start',
      'tool-end',
      'message',
    ]);
    expect(sessions[0]!.disconnected).toBe(true);
    expect(sessions[0]!.cfg.skipCustomInstructions).toBe(true);
    expect(sessions[0]!.cfg.excludedTools).toEqual(['task']);
  });

  it('falls back to JSON in the final message', async () => {
    const { client } = fakeClient(async (_cfg, emit) => {
      emit('assistant.message', { content: '```json\n{"updates":{"word":"dog"}}\n```' });
      emit('session.idle');
    });
    const p = new CopilotProvider({ clientFactory: () => client });
    const res = await p.runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(res.result).toEqual({ updates: { word: 'dog' } });
  });

  it('aborts the live session', async () => {
    const ctrl = new AbortController();
    const { client, sessions } = fakeClient(async (_cfg, emit) => {
      emit('assistant.message_delta', { deltaContent: 'working' });
    });
    const p = new CopilotProvider({ clientFactory: () => client });
    const run = p.runAgent({
      pause,
      state: {},
      visit: 0,
      signal: ctrl.signal,
      onEvent: () => ctrl.abort(),
    });
    await expect(run).rejects.toThrow(/aborted/);
    expect(sessions[0]!.aborted).toBe(true);
  });

  it('drafts with only the custom draft tool available', async () => {
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      await callTool(cfg, 'submit_draft', { pattern: { name: 'x' } });
      emit('session.idle');
    });
    const p = new CopilotProvider({ clientFactory: () => client });
    const res = await p.draft({
      request: 'r',
      instructions: 'i',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(res.result).toEqual({ name: 'x' });
    expect(sessions[0]!.cfg.availableTools).toBeDefined();
  });

  it('explains authentication failures', async () => {
    const client: ClientLike = {
      start: async () => {},
      stop: async () => {},
      createSession: async () => {
        throw new Error('Authentication failed: Bad credentials');
      },
    };
    const p = new CopilotProvider({ clientFactory: () => client, gitHubToken: 'x' });
    await expect(
      p.runAgent({
        pause,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow(/remove GITHUB_TOKEN \/ TOKEN in \.env/);
  });
});
