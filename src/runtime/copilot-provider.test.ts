import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatUsage } from '../core/usage.js';
import type { SessionConfig } from '@github/copilot-sdk';
import { compileScore } from '../core/compile.js';
import { replayPerformance } from '../core/replay.js';
import type { AgentPause, Pattern } from '../core/types.js';
import {
  CopilotProvider,
  ISOLATED_SYSTEM,
  SIGN_IN_HELP,
  normalizeSubmission,
  withoutTokenVars,
  parseTiers,
  type ClientLike,
  type SessionLike,
} from './copilot-provider.js';
import type { ProviderEvent } from './provider.js';
import { Run } from './driver.js';

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

const listModels = async () => [{ id: 'claude-haiku-5.5', supportedReasoningEfforts: ['low'] }];

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
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      });
      emit('tool.execution_complete', { toolCallId: 't1', success: true });
      emit('assistant.usage', {
        model: 'm1',
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 900,
      });
      emit('assistant.usage', { model: 'm1', inputTokens: 300, outputTokens: 20 });
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
    expect(res.result).toEqual({
      updates: { word: 'cat' },
      verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
    });
    expect(res.transcript).toMatchObject({ provider: 'copilot', model: 'm1', output: 'Done.' });
    expect(res.transcript.usage).toEqual({
      calls: 2,
      inputTokens: 1500,
      outputTokens: 100,
      cacheReadTokens: 900,
      reasoningTokens: 0,
    });
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
    expect(sessions[0]!.cfg.systemMessage).toBeUndefined();
  });

  it('a content filter block is answered by another model, nearest tier first', async () => {
    const BLOCK =
      'The model returned no content because the response was blocked by content filtering.';
    const play = (blocking: string[]) =>
      fakeClient(async (cfg, emit) => {
        if (blocking.includes(cfg.model!)) {
          emit('assistant.usage', { model: cfg.model, inputTokens: 100, outputTokens: 0 });
          emit('assistant.message', { content: BLOCK, model: cfg.model });
        } else {
          await callTool(cfg, 'submit_result', {
            updates: { word: 'dog' },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          });
          emit('assistant.usage', { model: cfg.model, inputTokens: 100, outputTokens: 10 });
          emit('assistant.message', { content: 'Done.', model: cfg.model });
        }
        emit('session.idle');
      });
    const tiers = { 1: { model: 'c' }, 2: { model: 'b' }, 3: { model: 'a' }, 4: { model: 'a' } };
    const run = async (blocking: string[]) => {
      const { client, sessions } = play(blocking);
      const events: string[] = [];
      const p = new CopilotProvider({
        clientFactory: () => ({
          ...client,
          listModels: async () => ['a', 'b', 'c'].map((id) => ({ id })),
        }),
        tiers,
      });
      const res = await p.runAgent({
        pause: { ...pause, complexity: 3 },
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: (e) => e.type === 'info' && events.push(e.text),
      });
      return { res, models: sessions.map((x) => x.cfg.model), events };
    };

    const healed = await run(['a', 'b']);
    expect(healed.models).toEqual(['a', 'b', 'c']);
    expect(healed.res.result).toMatchObject({ updates: { word: 'dog' } });
    expect(healed.res.transcript.model).toBe('c');
    expect(healed.res.transcript.musician).toMatchObject({
      requestedModel: 'a',
      blockedOn: ['a', 'b'],
    });
    expect(healed.res.transcript.usage).toMatchObject({
      calls: 3,
      inputTokens: 300,
      outputTokens: 10,
    });
    expect(healed.events.filter((t) => t.includes('content filtering'))).toEqual([
      'a blocked the response (content filtering); trying b',
      'b blocked the response (content filtering); trying c',
    ]);

    // Every model blocks: the engine gets no result and says why (engine.noResult).
    const blocked = await run(['a', 'b', 'c']);
    expect(blocked.res.result).toBeUndefined();
    expect(blocked.res.transcript.output).toBe(BLOCK);

    // A normal answer never tries another model.
    expect((await run([])).models).toEqual(['a']);
  });

  it('sends citations the workspace does not back up back to the AI, in the same session', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'symphony-cites-'));
    writeFileSync(join(ws, 'a.js'), 'const port = 8081;\n');
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const replies: string[] = [];
    const { client } = fakeClient(async (cfg, emit) => {
      replies.push(
        String(
          await callTool(cfg, 'submit_result', {
            updates: { findings: ['a.js:1 — the port `port = 8080`', 'b.js:3 — imports a'] },
            verdict,
          }),
        ),
      );
      replies.push(
        String(
          await callTool(cfg, 'submit_result', {
            updates: { findings: ['a.js:1 — the port `port = 8081`'] },
            verdict,
          }),
        ),
      );
      emit('session.idle');
    });
    const p = new CopilotProvider({ clientFactory: () => client, workingDirectory: ws });
    const res = await p.runAgent({
      pause: {
        ...pause,
        outputSchema: [{ name: 'findings', type: 'string[]' }],
        cites: 'findings',
      },
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    rmSync(ws, { recursive: true, force: true });
    expect(replies[0]).toMatch(/^REJECTED/);
    expect(replies[0]).toContain('the quote `port = 8080` is not at a.js:1');
    expect(replies[0]).toContain('b.js does not exist in the workspace');
    expect(replies[1]).toMatch(/^Result recorded/);
    expect(res.result).toMatchObject({
      updates: { findings: ['a.js:1 — the port `port = 8081`'] },
    });
  });

  it("applies the step's own checks in-session, so an empty answer is sent back at once", async () => {
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const replies: string[] = [];
    const { client } = fakeClient(async (cfg, emit) => {
      for (const words of [[], ['cat', 'dog']]) {
        replies.push(String(await callTool(cfg, 'submit_result', { updates: { words }, verdict })));
      }
      emit('session.idle');
    });
    const p = new CopilotProvider({ clientFactory: () => client });
    const res = await p.runAgent({
      pause: {
        ...pause,
        outputSchema: [{ name: 'words', type: 'string[]' }],
        checks: [{ expr: 'len(words) >= min', message: 'Give at least min words.' }],
      },
      state: { min: 2 },
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(replies[0]).toMatch(/^REJECTED[\s\S]*Give at least min words\./);
    expect(replies[1]).toMatch(/^Result recorded/);
    expect(res.result).toMatchObject({ updates: { words: ['cat', 'dog'] } });
  });

  it('a step that wants another model family gets one when it is available', async () => {
    const play = async (models: string[]) => {
      const notes: string[] = [];
      const { client, sessions } = fakeClient(async (cfg, emit) => {
        await callTool(cfg, 'submit_result', {
          updates: { word: 'dog' },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        });
        emit('session.idle');
      });
      const p = new CopilotProvider({
        clientFactory: () => ({ ...client, listModels: async () => models.map((id) => ({ id })) }),
        tiers: { 2: { model: 'claude-sonnet-5' } },
      });
      await p.runAgent({
        pause: { ...pause, otherModel: true },
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: (e) => e.type === 'info' && notes.push(e.text),
      });
      return { model: sessions[0]!.cfg.model, notes };
    };
    const other = await play(['claude-sonnet-5', 'gpt-6.1-sol']);
    expect(other.model).toBe('gpt-6.1-sol');
    expect(other.notes[0]).toMatch(
      /second opinion on gpt-6.1-sol, another model family than claude-sonnet-5/,
    );
    const same = await play(['claude-sonnet-5']);
    expect(same.model).toBe('claude-sonnet-5');
    expect(same.notes[0]).toMatch(/no model from another family is available/);
  });

  it('not signed in: stops with how to sign in, before any session (or when the CLI says so)', async () => {
    const req = {
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    };
    const nobody = fakeClient(async () => {});
    const p = new CopilotProvider({
      clientFactory: () => ({
        ...nobody.client,
        getAuthStatus: async () => ({ isAuthenticated: false }),
      }),
    });
    await expect(p.runAgent(req)).rejects.toMatchObject({
      name: 'SetupError',
      message: SIGN_IN_HELP,
    });
    expect(nobody.sessions).toHaveLength(0);
    expect(await p.authStatus()).toEqual({ signedIn: false, message: SIGN_IN_HELP });

    // An older CLI that does not report status answers with the error as its message.
    const cli = fakeClient(async (_cfg, emit) => {
      emit('assistant.message', {
        content:
          '[Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided]',
      });
      emit('session.idle');
    });
    await expect(
      new CopilotProvider({ clientFactory: () => cli.client }).runAgent(req),
    ).rejects.toMatchObject({ name: 'SetupError' });

    // A used-up quota stops the run at once: every retry would be refused the same way.
    const broke = fakeClient(async (_cfg, emit) => {
      emit('session.error', {
        message: 'You have exceeded your monthly quota (Request ID: 3BAB:F09)',
      });
      emit('session.idle');
    });
    await expect(
      new CopilotProvider({ clientFactory: () => broke.client }).runAgent(req),
    ).rejects.toMatchObject({
      name: 'SetupError',
      message: expect.stringMatching(
        /quota is used up.*exceeded your monthly quota.*Retrying cannot help/,
      ),
    });
  });

  it('keeps the last valid answer: a later bad or parallel call never replaces it', async () => {
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const play = async (calls: unknown[]) => {
      const replies: string[] = [];
      const { client } = fakeClient(async (cfg, emit) => {
        for (const c of calls) replies.push(String(await callTool(cfg, 'submit_result', c)));
        emit('session.idle');
      });
      const res = await new CopilotProvider({ clientFactory: () => client }).runAgent({
        pause,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      return { result: res.result, replies };
    };
    const good = { updates: { word: 'cat' }, verdict };
    // A garbled parallel call after a good one: the good one stays.
    expect((await play([good, { updates: 'oops' }])).result).toEqual(good);
    // A deliberate correction (both valid): the later one wins.
    const better = { updates: { word: 'dog' }, verdict };
    expect((await play([good, better])).result).toEqual(better);
    // updates sent as a JSON string is repaired, not rejected.
    const text = await play([{ updates: '{"word":"owl"}', verdict }]);
    expect(text.replies[0]).toMatch(/^Result recorded/);
    expect(text.result).toEqual({ updates: { word: 'owl' }, verdict });
    // Never valid: the last bad answer reaches the engine, which says why.
    const bad = await play([{ updates: {} }, { updates: {} }, { updates: {} }]);
    expect(bad.replies.map((r) => r.split('\n')[0])).toEqual([
      'REJECTED: the result was not recorded.',
      'REJECTED: the result was not recorded.',
      'Result recorded. Your step is complete: stop now.',
    ]);
    expect(bad.result).toEqual({ updates: {} });
  });

  it('normalizeSubmission parses string-encoded JSON only where it is an object', () => {
    expect(normalizeSubmission('{"updates":{"a":1}}')).toEqual({ updates: { a: 1 } });
    expect(normalizeSubmission({ updates: '{"a":1}' })).toEqual({ updates: { a: 1 } });
    expect(normalizeSubmission({ updates: '[1]' })).toEqual({ updates: '[1]' });
    expect(normalizeSubmission({ updates: 'not json' })).toEqual({ updates: 'not json' });
  });

  it('records what the provider reports beyond tokens: time, cost, cache writes, compactions', async () => {
    const { client } = fakeClient(async (cfg, emit) => {
      await callTool(cfg, 'submit_result', {
        updates: { word: 'cat' },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      });
      const call = {
        inputTokens: 100,
        outputTokens: 5,
        cacheWriteTokens: 40,
        duration: 1500,
        timeToFirstTokenMs: 400,
        cost: 1,
        copilotUsage: { totalNanoAiu: 2000 },
      };
      emit('assistant.usage', { model: 'm', ...call });
      emit('session.compaction_complete', { success: true });
      emit('assistant.usage', { model: 'm', ...call });
      emit('session.idle');
    });
    const res = await new CopilotProvider({ clientFactory: () => client }).runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(res.transcript.usage).toEqual({
      calls: 2,
      inputTokens: 200,
      outputTokens: 10,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      cacheWriteTokens: 80,
      apiMs: 3000,
      firstTokenMs: 800,
      premiumRequests: 2,
      nanoAiu: 4000,
      compactions: 1,
    });
    expect(formatUsage(res.transcript.usage!)).toBe(
      '200 in · 10 out · 2 calls · 3.0s in the model, first token 0.4s avg · 2 premium requests · compacted 1×',
    );
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

  it('sends a malformed submission back to the AI in the same session', async () => {
    const replies: unknown[] = [];
    const verdict = { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'ok' };
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      replies.push(await callTool(cfg, 'submit_result', { updates: '<parameter name="word">x' }));
      replies.push(await callTool(cfg, 'submit_result', { updates: { word: 'x' } }));
      replies.push(await callTool(cfg, 'submit_result', { updates: { word: 'cat' }, verdict }));
      emit('session.idle');
    });
    const events: ProviderEvent[] = [];
    const p = new CopilotProvider({ clientFactory: () => client });
    const res = await p.runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    expect(sessions).toHaveLength(1);
    expect(replies[0]).toMatch(/^REJECTED[\s\S]*updates arrived as text/);
    expect(replies[1]).toMatch(/verdict is missing/);
    expect(replies[2]).toMatch(/Result recorded/);
    expect(res.result).toEqual({ updates: { word: 'cat' }, verdict });
    expect(
      events.filter((e) => e.type === 'info' && /submit_result rejected/.test(e.text)),
    ).toHaveLength(2);
  });

  it('stops correcting after two tries and lets the engine judge', async () => {
    const replies: unknown[] = [];
    const { client } = fakeClient(async (cfg, emit) => {
      for (let i = 0; i < 3; i++)
        replies.push(await callTool(cfg, 'submit_result', { updates: { word: 'x' } }));
      emit('session.idle');
    });
    const res = await new CopilotProvider({ clientFactory: () => client }).runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(replies.map((r) => String(r).slice(0, 8))).toEqual(['REJECTED', 'REJECTED', 'Result r']);
    expect(res.result).toEqual({ updates: { word: 'x' } });
  });

  it('re-resolves the model after falling back from a rejected token', async () => {
    const created: (string | undefined)[] = [];
    const factory = (auth: { gitHubToken?: string }) => {
      const { client } = fakeClient(async (cfg, emit) => {
        await callTool(cfg, 'submit_result', { updates: { word: 'cat' } });
        emit('session.idle');
      });
      if (!auth.gitHubToken) {
        return {
          ...client,
          listModels: async () => [{ id: 'claude-haiku-5.5', supportedReasoningEfforts: ['low'] }],
          createSession: async (cfg: Parameters<typeof client.createSession>[0]) => {
            created.push(cfg.model);
            return client.createSession(cfg);
          },
        };
      }
      return {
        ...client,
        listModels: async () => {
          throw new Error('Authentication failed (401)');
        },
        createSession: async () => {
          throw new Error('Authentication failed: Bad credentials');
        },
      };
    };
    const p = new CopilotProvider({
      clientFactory: factory,
      gitHubToken: 'bad',
      model: 'gone-model',
    });
    const res = await p.runAgent({
      pause: { ...pause, complexity: 1 },
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(res.result).toEqual({ updates: { word: 'cat' } });
    expect(created).toEqual(['claude-haiku-5.5']);
  });

  it('a token Copilot refuses mid-session gives way to the signed-in account; then it stops with why', async () => {
    const REFUSED = '[Authorization error, you may need to run /login (Request ID: B233:3B33)]';
    const play = (signedInWorks: boolean) => {
      const auths: { gitHubToken?: string }[] = [];
      const factory = (auth: { gitHubToken?: string }) => {
        auths.push(auth);
        const works = !auth.gitHubToken && signedInWorks;
        return fakeClient(async (cfg, emit) => {
          if (works) await callTool(cfg, 'submit_result', { updates: { word: 'cat' } });
          else emit('assistant.message', { content: REFUSED });
          emit('session.idle');
        }).client;
      };
      const events: string[] = [];
      const p = new CopilotProvider({
        clientFactory: factory,
        gitHubToken: 'ghp_old',
        gitHubTokenSource: 'TOKEN',
      });
      const run = p.runAgent({
        pause,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: (e) => e.type === 'info' && events.push(e.text),
      });
      return { run, auths, events };
    };
    const healed = play(true);
    expect((await healed.run).result).toEqual({ updates: { word: 'cat' } });
    expect(healed.auths).toEqual([{ gitHubToken: 'ghp_old' }, {}]);
    expect(healed.events.join('\n')).toMatch(/Copilot refused the token in TOKEN/);

    const stuck = play(false);
    await expect(stuck.run).rejects.toMatchObject({
      name: 'SetupError',
      message: expect.stringContaining(
        'Copilot refused the GitHub account signed in on this machine',
      ),
    });
  });

  it('a configured token the sign-in check rejects gives way to the signed-in account', async () => {
    const auths: { gitHubToken?: string }[] = [];
    const factory = (auth: { gitHubToken?: string }) => {
      auths.push(auth);
      const { client } = fakeClient(async (cfg, emit) => {
        await callTool(cfg, 'submit_result', { updates: { word: 'cat' } });
        emit('session.idle');
      });
      return { ...client, getAuthStatus: async () => ({ isAuthenticated: !auth.gitHubToken }) };
    };
    const events: string[] = [];
    const p = new CopilotProvider({
      clientFactory: factory,
      gitHubToken: 'bad',
      gitHubTokenSource: 'TOKEN',
    });
    const res = await p.runAgent({
      pause,
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: (e) => e.type === 'info' && events.push(e.text),
    });
    expect(res.result).toEqual({ updates: { word: 'cat' } });
    expect(auths).toEqual([{ gitHubToken: 'bad' }, {}]);
    expect(events.join('\n')).toMatch(/the token in TOKEN is not signed in to Copilot/);
  });

  it('the signed-in account is used without token variables the CLI would prefer', () => {
    expect(
      withoutTokenVars({
        PATH: '/bin',
        GITHUB_TOKEN: 'a',
        GH_TOKEN: 'b',
        COPILOT_GITHUB_TOKEN: 'c',
      }),
    ).toEqual({ PATH: '/bin' });
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
    const first = await go(1);
    expect(sessions[0]!.cfg).toMatchObject({ model: 'claude-haiku-5.5', reasoningEffort: 'low' });
    expect(first.transcript.musician).toEqual({
      tier: 1,
      requestedModel: 'claude-haiku-5.5',
      effort: 'low',
      account: 'signed-in user',
      sdk: expect.stringMatching(/^@github\/copilot-sdk@\d+\.\d+\.\d+/),
      sampling: expect.stringMatching(/does not expose seed or temperature/),
    });
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
    // No workspace tools, so not the SDK's long system prompt about them either.
    expect(sessions[0]!.cfg.systemMessage).toEqual({ mode: 'replace', content: ISOLATED_SYSTEM });
    expect(res.transcript.prompt).toContain('## Solo: you choose where the tune goes next');
    const schema = sessions[0]!.cfg.tools![0]!.parameters as { required: string[] };
    expect(schema.required).toContain('next');
  });
});

// Regression: a live investigate run failed at deepRead after the model garbled its
// submit_result call and then kept omitting the verdict on fresh retries.
describe('CopilotProvider + engine: malformed submissions', () => {
  const deepRead: Pattern = {
    name: 'deep-read',
    description: 'one read-only step',
    requiredContext: [],
    state: [
      { name: 'examined', type: 'string[]' },
      { name: 'newFindings', type: 'string[]' },
    ],
    nodes: [
      { id: 'start', kind: 'start', label: 'Start' },
      {
        id: 'deepRead',
        kind: 'agent',
        role: 'assessor',
        label: 'Deep read',
        directive: 'read',
        reads: [],
        writes: ['examined', 'newFindings'],
        retries: 2,
      },
      { id: 'done', kind: 'end', label: 'Done', outcome: 'success' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'deepRead' },
      { id: 'e2', from: 'deepRead', to: 'done' },
    ],
    start: 'start',
  };
  const score = compileScore(deepRead, { goal: 'read', generatedAt: 't' });
  const updates = { examined: ['src/cli.ts'], newFindings: ['src/cli.ts:1 — finding'] };
  const verdict = { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'read' };
  const garbled = {
    updates: '\n<parameter name="examined">["src/cli.ts"]',
    verdict: '\n<parameter name="outcome">applied',
  };

  it('a garbled call and a missing verdict are fixed in-session: one clean engine attempt', async () => {
    // Like a real model: it submits again only when told its call was rejected.
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      for (const attempt of [garbled, { updates }, { updates, verdict }]) {
        const reply = String(await callTool(cfg, 'submit_result', attempt));
        if (!reply.startsWith('REJECTED')) break;
      }
      emit('session.idle');
    });
    const run = new Run({
      score,
      provider: new CopilotProvider({ clientFactory: () => client }),
      clock: () => 't',
    });
    const perf = await run.start();
    expect(perf.outcome).toBe('success');
    expect(sessions).toHaveLength(1);
    expect(perf.events.filter((e) => e.type === 'response-rejected')).toEqual([]);
    expect(perf.finalState).toMatchObject(updates);
    expect(perf.steps.find((s) => s.nodeId === 'deepRead')!.attempts ?? []).toEqual([]);
    expect(replayPerformance(score, perf).divergence.reproduced).toBe(true);
  });

  it('an answer the AI never fixes is still rejected by the engine and fails the run', async () => {
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      for (let i = 0; i < 5; i++) {
        const reply = String(await callTool(cfg, 'submit_result', { updates }));
        if (!reply.startsWith('REJECTED')) break;
      }
      emit('session.idle');
    });
    const run = new Run({
      score,
      provider: new CopilotProvider({ clientFactory: () => client }),
      clock: () => 't',
      autoApprove: true,
    });
    const perf = await run.start();
    expect(perf.outcome).toBe('failed');
    expect(sessions).toHaveLength(3);
    const rejected = perf.events.filter((e) => e.type === 'response-rejected');
    expect(rejected).toHaveLength(3);
    expect(perf.finalState.examined).toEqual([]);
    expect(perf.reason).toMatch(/deepRead.*verdict is missing/);
  });
});
