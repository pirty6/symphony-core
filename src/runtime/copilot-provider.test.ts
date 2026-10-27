import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '@github/copilot-sdk';
import type { AgentPause } from '../core/types.js';
import {
  CopilotProvider,
  parseTiers,
  type ClientLike,
  type SessionLike,
} from './copilot-provider.js';
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
  capabilities: [],
  complexity: 2,
  improvisation: 0,
  isolated: false,
  takes: 1,
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
      'info',
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
      onEvent: (e) => e.type === 'delta' && ctrl.abort(),
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

  it('falls back to the signed-in user when the configured token is rejected', async () => {
    const auths: { gitHubToken?: string }[] = [];
    const factory = (auth: { gitHubToken?: string }) => {
      auths.push(auth);
      const { client } = fakeClient(async (cfg, emit) => {
        await callTool(cfg, 'submit_result', { updates: { word: 'cat' } });
        emit('session.idle');
      });
      if (!auth.gitHubToken) return client;
      return {
        ...client,
        createSession: async () => {
          throw new Error(
            'Authentication failed: Failed to validate SDK token (401): Bad credentials',
          );
        },
      };
    };
    const events: ProviderEvent[] = [];
    const p = new CopilotProvider({ clientFactory: factory, gitHubToken: 'bad' });
    const res = await p.runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    expect(res.result).toEqual({ updates: { word: 'cat' } });
    expect(auths).toEqual([{ gitHubToken: 'bad' }, {}]);
    expect(events.find((e) => e.type === 'info' && /falling/.test(e.text))).toMatchObject({
      type: 'info',
      text: expect.stringMatching(/falling back to your signed-in GitHub user/),
    });
    expect(p.usingSignedInUser).toBe(true);
    // later nodes go straight to the signed-in user
    await p.runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(auths).toHaveLength(2);
  });

  it('explains when both the token and the signed-in user fail', async () => {
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
    ).rejects.toThrow(/Both the configured token and your signed-in GitHub user were rejected/);
  });

  it('honours stop while the session is still being created', async () => {
    const ctrl = new AbortController();
    let sent = false;
    const client: ClientLike = {
      start: async () => {},
      stop: async () => {},
      createSession: async (cfg) => {
        await new Promise((r) => setTimeout(r, 30));
        const s = new FakeSession(cfg, async () => {});
        s.send = async () => {
          sent = true;
          return 'm';
        };
        return s;
      },
    };
    const p = new CopilotProvider({ clientFactory: () => client });
    const run = p.runAgent({ pause, state: {}, visit: 0, signal: ctrl.signal, onEvent: () => {} });
    setTimeout(() => ctrl.abort(), 5);
    await expect(run).rejects.toThrow(/aborted/);
    expect(sent).toBe(false);
  });

  it('adds web_search and MCP servers only for nodes with those capabilities', async () => {
    const queries: string[] = [];
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      if (cfg.tools!.some((t) => t.name === 'web_search')) {
        const out = await callTool(cfg, 'web_search', { query: 'vitest timers' });
        emit('assistant.message', { content: String(out) });
      }
      await callTool(cfg, 'submit_result', { updates: { word: 'x' } });
      emit('session.idle');
    });
    const p = new CopilotProvider({
      clientFactory: () => client,
      mcpServers: {
        teams: { type: 'stdio', command: 'agency', args: ['mcp', 'teams'], tools: ['*'] },
      },
      webSearch: async (q) => {
        queries.push(q);
        return [{ title: 'Timers', url: 'https://vitest.dev/timers', snippet: 'fake timers' }];
      },
    });
    const go = (capabilities: ('web' | 'mcp')[]) =>
      p.runAgent({
        pause: { ...pause, capabilities },
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: () => {},
      });
    const withBoth = await go(['web', 'mcp']);
    expect(queries).toEqual(['vitest timers']);
    expect(withBoth.transcript.output).toContain('https://vitest.dev/timers');
    expect(withBoth.transcript.prompt).toContain('MCP servers: teams');
    expect(sessions[0]!.cfg.mcpServers).toHaveProperty('teams');
    await go([]);
    expect(sessions[1]!.cfg.tools!.map((t) => t.name)).toEqual(['submit_result']);
    expect(sessions[1]!.cfg.mcpServers).toBeUndefined();
  });

  it('picks the model and effort from the complexity tier, checked against available models', async () => {
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      await callTool(cfg, 'submit_result', { updates: { word: 'x' } });
      emit('session.idle');
    });
    const withModels = {
      ...client,
      listModels: async () => [
        { id: 'claude-haiku-5.5', supportedReasoningEfforts: ['low', 'medium'] },
        { id: 'claude-opus-5.5', supportedReasoningEfforts: [] },
      ],
    };
    const events: ProviderEvent[] = [];
    const p = new CopilotProvider({
      clientFactory: () => withModels,
      tiers: { 4: { model: 'claude-opus-5.5', effort: 'xhigh' } },
    });
    const go = (complexity: 1 | 2 | 3 | 4, extra = {}) =>
      p.runAgent({
        pause: { ...pause, complexity },
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
        ...extra,
      });
    await go(1);
    expect(sessions[0]!.cfg).toMatchObject({ model: 'claude-haiku-5.5', reasoningEffort: 'low' });
    await go(4);
    expect(sessions[1]!.cfg.model).toBe('claude-opus-5.5');
    expect(sessions[1]!.cfg.reasoningEffort).toBeUndefined();
    await go(2);
    expect(sessions[2]!.cfg.model).toBeUndefined();
    expect(
      events.some(
        (e) => e.type === 'info' && /tier 2 model 'claude-sonnet-5' is not available/.test(e.text),
      ),
    ).toBe(true);
    const merged = await go(1, {
      integrate: [{ updates: { word: 'a' } }, { updates: { word: 'b' } }],
    });
    expect(merged.transcript.prompt).toContain('integrating 2 independent takes');
    expect(sessions[3]!.cfg.availableTools).toBeDefined();
    expect(parseTiers('1=m1:low, 4=m4')).toEqual({
      1: { model: 'm1', effort: 'low' },
      4: { model: 'm4' },
    });
    expect(() => parseTiers('5=x')).toThrow(/invalid tier/);
  });

  it('ignores a forced MODEL the account cannot use and falls back to the tiers', async () => {
    const listModels = async () => [{ id: 'claude-haiku-5.5', supportedReasoningEfforts: ['low'] }];
    const unavailable = new CopilotProvider({
      clientFactory: () => ({ ...fakeClient(async () => {}).client, listModels }),
      model: 'claude-opus-4.6',
    });
    expect(await unavailable.modelFor(1)).toEqual({
      model: 'claude-haiku-5.5',
      effort: 'low',
      note: "model 'claude-opus-4.6' (MODEL) is not available to you; using tier 1 'claude-haiku-5.5'",
    });
    const ok = new CopilotProvider({
      clientFactory: () => ({ ...fakeClient(async () => {}).client, listModels }),
      model: 'claude-haiku-5.5',
    });
    expect(await ok.modelFor(4)).toEqual({ model: 'claude-haiku-5.5' });
  });

  it('isolated agents get only the submit tool and solo answers carry next', async () => {
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      await callTool(cfg, 'submit_result', { updates: {}, next: 'go' });
      emit('session.idle');
    });
    const p = new CopilotProvider({ clientFactory: () => client });
    const choices = [{ edgeId: 'go', label: 'act', to: 'act' }];
    const res = await p.runAgent({
      pause: { ...pause, isolated: true, choices },
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(res.result).toMatchObject({ next: 'go' });
    expect(sessions[0]!.cfg.availableTools).toBeDefined();
    expect(res.transcript.prompt).toContain('## Solo: you choose where the tune goes next');
    const schema = sessions[0]!.cfg.tools![0]!.parameters as { required: string[] };
    expect(schema.required).toContain('next');
  });
});
