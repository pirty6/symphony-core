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
  KUSTO_TOOL,
  SIGN_IN_HELP,
  emptiedFields,
  hasContent,
  normalizeSubmission,
  retryAfterMs,
  withoutTokenVars,
  parseTiers,
  splitModelEffort,
  type ClientLike,
  type SessionLike,
} from './copilot-provider.js';
import type { ProviderEvent } from './provider.js';
import { Run } from './driver.js';
import { modelSettings } from './repertoire.js';

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
  readonly sent: string[] = [];
  async send(message?: { prompt: string }) {
    if (message) this.sent.push(message.prompt);
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

/** The update fields the submit_result tool's schema requires, in a played session. */
const required = (r: { session: { cfg: SessionConfig } }) =>
  (
    r.session.cfg.tools!.find((t) => t.name === 'submit_result') as unknown as {
      parameters: { properties: { updates: { required?: string[] } } };
    }
  ).parameters.properties.updates.required ?? [];

const fixVerdict = (v: unknown) =>
  (normalizeSubmission({ updates: { a: 1 }, verdict: v }) as { verdict: unknown }).verdict;

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
      emit('session.usage_info', {
        currentTokens: 900,
        systemTokens: 700,
        toolDefinitionsTokens: 150,
        conversationTokens: 50,
        tokenLimit: 200000,
        messagesLength: 1,
      });
      emit('session.usage_info', { currentTokens: 1500, systemTokens: 700, messagesLength: 3 });
      emit('assistant.usage', {
        model: 'm1',
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 900,
        cacheWriteTokens: 300,
        duration: 1500,
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
      cacheWriteTokens: 300,
      apiMs: 1500,
    });
    // Each call on its own, in order, and the context the session started with.
    expect(res.transcript.calls).toEqual([
      {
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 900,
        cacheWriteTokens: 300,
        ms: 1500,
        // The call that submitted is tagged; the closing one after it is not.
        submits: ['recorded'],
      },
      { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 },
    ]);
    expect(res.transcript.context).toEqual({
      systemTokens: 700,
      toolDefinitionsTokens: 150,
      conversationTokens: 50,
      tokenLimit: 200000,
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
    const tiers = {
      1: { model: 'c', effort: 'low' as const },
      2: { model: 'b' },
      3: { model: 'a', effort: 'high' as const },
      4: { model: 'a' },
    };
    const run = async (blocking: string[]) => {
      const { client, sessions } = play(blocking);
      const events: string[] = [];
      const p = new CopilotProvider({
        clientFactory: () => ({
          ...client,
          listModels: async () =>
            ['a', 'b', 'c'].map((id) => ({ id, supportedReasoningEfforts: ['low', 'high'] })),
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
      // The effort asked with the requested model (replay's key), and the one that answered.
      effort: 'high',
      answeredEffort: 'low',
    });
    // The blocked calls answered nothing: tagged, so their time is not the answer's.
    expect(healed.res.transcript.calls!.map((c) => c.blocked ?? false)).toEqual([
      true,
      true,
      false,
    ]);
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

  it('checks every field a step cites in-session, not only the first (citesAlso)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cites-also-'));
    writeFileSync(join(ws, 'a.js'), 'const port = 8081;\n');
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const replies: string[] = [];
    const { client } = fakeClient(async (cfg, emit) => {
      for (const behaviours of [
        ['B1 a.js:1 — the port `port = 9090`'],
        ['B1 a.js:1 — the port `port = 8081`'],
      ])
        replies.push(
          String(
            await callTool(cfg, 'submit_result', {
              updates: { context: ['a.js:1 — [SIMILAR] the port `port = 8081`'], behaviours },
              verdict,
            }),
          ),
        );
      emit('session.idle');
    });
    const p = new CopilotProvider({ clientFactory: () => client, workingDirectory: ws });
    await p.runAgent({
      pause: {
        ...pause,
        outputSchema: [
          { name: 'context', type: 'string[]' },
          { name: 'behaviours', type: 'string[]' },
        ],
        cites: 'context',
        citesAlso: ['behaviours'],
      },
      state: {},
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    rmSync(ws, { recursive: true, force: true });
    expect(replies[0]).toMatch(/^REJECTED[\s\S]*behaviours: "B1 a\.js:1/);
    expect(replies[1]).toMatch(/^Result recorded/);
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

  it('a rate limit before the session did anything waits and starts again; it is recorded', async () => {
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const play = async (limited: number, delays = [1, 1, 1]) => {
      let tries = 0;
      const notes: string[] = [];
      const { client, sessions } = fakeClient(async (cfg, emit) => {
        tries += 1;
        if (tries <= limited) emit('session.error', { message: 'HTTP 429 Too Many Requests' });
        else await callTool(cfg, 'submit_result', { updates: { word: 'cat' }, verdict });
        emit('session.idle');
      });
      const res = await new CopilotProvider({
        clientFactory: () => client,
        rateLimitDelaysMs: delays,
      }).runAgent({
        pause,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: (e) => e.type === 'info' && notes.push(e.text),
      });
      return { res, tries, notes, sessions };
    };
    const ok = await play(2);
    expect(ok.tries).toBe(3);
    expect(ok.res.result).toMatchObject({ updates: { word: 'cat' } });
    expect(ok.res.transcript.musician?.rateLimitWaits).toBe(2);
    expect(ok.notes.filter((n) => n.startsWith('rate limited'))).toHaveLength(2);
    // Past the last wait, the failure goes to the engine as before.
    const out = await play(5);
    expect(out.tries).toBe(4);
    expect(out.res.result).toBeUndefined();
    expect(out.res.transcript.output).toMatch(/429/);
    expect(retryAfterMs('rate limited, retry after 20 seconds')).toBe(20_000);
    expect(retryAfterMs('Retry-After: 500ms')).toBe(500);
    expect(retryAfterMs('HTTP 429')).toBeUndefined();
  });

  describe('trial switches', () => {
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const play = async (
      opts: Partial<ConstructorParameters<typeof CopilotProvider>[0]>,
      calls: unknown[],
      over: Partial<AgentPause> = {},
      models: (string | { id: string; supportedReasoningEfforts: string[] })[] = [
        'claude-sonnet-5',
        'claude-opus-5.5',
      ],
    ) => {
      const replies: string[] = [];
      const { client, sessions } = fakeClient(async (cfg, emit) => {
        for (const c of calls) replies.push(String(await callTool(cfg, 'submit_result', c)));
        emit('session.idle');
      });
      const provider = new CopilotProvider({
        clientFactory: () => ({
          ...client,
          listModels: async () => models.map((m) => (typeof m === 'string' ? { id: m } : m)),
        }),
        tiers: { 2: { model: 'claude-sonnet-5' } },
        ...opts,
      });
      const p = { ...pause, ...over };
      const res = await provider.runAgent({
        pause: p,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      return { res, replies, session: sessions[0]!, requested: await provider.requested(p) };
    };
    const listed: Partial<AgentPause> = {
      outputSchema: [
        { name: 'items', type: 'string[]' },
        { name: 'notes', type: 'string[]' },
      ],
      checks: [{ expr: 'len(notes) == len(items)', message: 'One note per item.' }],
    };

    it('delta repair: after a rejection, the fields sent replace the rejected ones; the rest is kept', async () => {
      const first = { updates: { items: ['a', 'b'], notes: ['a — x'] }, verdict };
      const fix = { updates: { notes: ['a — x', 'b — y'] }, verdict };
      const on = await play({ deltaRepair: true }, [first, fix], listed);
      expect(on.replies[0]).toMatch(/One note per item/);
      expect(on.replies[0]).toMatch(/only the updates you change/);
      expect(on.replies[1]).toMatch(/^Result recorded/);
      expect(on.res.result).toEqual({
        updates: { items: ['a', 'b'], notes: ['a — x', 'b — y'] },
        verdict,
      });
      // Off (the default): the same partial answer is not enough.
      const off = await play({}, [first, fix], listed);
      expect(off.replies[0]).toMatch(/complete corrected result/);
      expect(off.replies[1]).toMatch(/^REJECTED/);
      // The tool's schema lets the correction through (a CLI that validates arguments against it
      // would otherwise refuse it before the merge); without delta repair every field is required.
      expect(required(on)).toEqual([]);
      expect(required(off)).toEqual(['items', 'notes']);
      expect(required(off).every((k) => k in fix.updates)).toBe(false);
      // A first answer missing a field is still sent back, in the same session.
      const partial = await play(
        { deltaRepair: true },
        [{ updates: { items: ['a'] }, verdict }],
        listed,
      );
      expect(partial.replies[0]).toMatch(/^REJECTED/);
      expect(partial.replies[0]).toMatch(/notes/);
    });

    it('header in the system message: the step instructions there, the input in the prompt', async () => {
      const call = { updates: { word: 'cat' }, verdict };
      const on = await play({ headerInSystem: true }, [call], { input: { topic: 'pets' } });
      const system = on.session.cfg.systemMessage as { mode?: string; content?: string };
      expect(system.mode).toBe('append');
      expect(system.content).toMatch(/^You are the ASSESSOR/);
      expect(system.content).toContain('## Your step: Pick word');
      expect(system.content).not.toContain('## Input');
      expect(on.session.sent[0]).toMatch(/^## Input \(current workflow state you may use\)/);
      expect(on.session.sent[0]).toContain('"topic":"pets"');
      // The transcript keeps the whole prompt, as before.
      expect(on.res.transcript.prompt).toContain('## Your step: Pick word');
      const off = await play({}, [call], { input: { topic: 'pets' } });
      expect(off.session.cfg.systemMessage).toBeUndefined();
      expect(off.session.sent[0]).toMatch(/^You are the ASSESSOR/);
      // Isolated steps keep their short system message, with the header after it.
      const iso = await play({ headerInSystem: true }, [call], { isolated: true });
      const isoSystem = iso.session.cfg.systemMessage as { mode?: string; content?: string };
      expect(isoSystem.mode).toBe('replace');
      expect(isoSystem.content!.startsWith(ISOLATED_SYSTEM)).toBe(true);
    });

    it('node models: a named step runs on its own model when available; replay asks for it too', async () => {
      const call = { updates: { word: 'cat' }, verdict };
      const own = await play({ nodeModels: { pick: 'claude-opus-5.5' } }, [call]);
      expect(own.session.cfg.model).toBe('claude-opus-5.5');
      expect(own.requested).toMatch(/^claude-opus-5\.5/);
      const other = await play({ nodeModels: { triage: 'claude-opus-5.5' } }, [call]);
      expect(other.session.cfg.model).toBe('claude-sonnet-5');
      const missing = await play({ nodeModels: { pick: 'nope-1' } }, [call]);
      expect(missing.session.cfg.model).toBe('claude-sonnet-5');
    });

    it("maxEffort caps the tier's effort; a named effort or SYMPHONY_EFFORT_CAPS=0 is played as is", async () => {
      const call = { updates: { word: 'cat' }, verdict };
      const all = ['low', 'medium', 'high', 'xhigh'];
      const models = [
        { id: 'claude-opus-5.5', supportedReasoningEfforts: all },
        { id: 'claude-sonnet-5', supportedReasoningEfforts: all },
        { id: 'only-xhigh', supportedReasoningEfforts: ['xhigh'] },
      ];
      const xhigh = { 2: { model: 'claude-opus-5.5', effort: 'xhigh' as const } };
      const capped: Partial<AgentPause> = { maxEffort: 'high' };
      const effortOf = async (
        opts: Partial<ConstructorParameters<typeof CopilotProvider>[0]>,
        over = capped,
      ) => {
        const r = await play(opts, [call], over, models);
        expect(r.requested).toBe(
          modelSettings(r.session.cfg.model!, r.session.cfg.reasoningEffort),
        );
        return r.session.cfg.reasoningEffort;
      };
      expect(await effortOf({ tiers: xhigh })).toBe('high');
      expect(await effortOf({ tiers: xhigh }, {})).toBe('xhigh');
      expect(await effortOf({ tiers: xhigh, effortCaps: false })).toBe('xhigh');
      // Below the cap, the tier's effort stands.
      expect(await effortOf({ tiers: { 2: { model: 'claude-opus-5.5', effort: 'medium' } } })).toBe(
        'medium',
      );
      // A node model without an effort inherits the tier's, capped; a named one is played as named.
      expect(await effortOf({ tiers: xhigh, nodeModels: { pick: 'claude-sonnet-5' } })).toBe(
        'high',
      );
      expect(await effortOf({ tiers: xhigh, nodeModels: { pick: 'claude-sonnet-5:xhigh' } })).toBe(
        'xhigh',
      );
      // A model that has no such effort keeps its own.
      expect(await effortOf({ tiers: { 2: { model: 'only-xhigh', effort: 'xhigh' } } })).toBe(
        'xhigh',
      );
    });

    it('node models: "model:effort" sets the effort; without one the step keeps its tier\'s', async () => {
      const call = { updates: { word: 'cat' }, verdict };
      const tiers = { 2: { model: 'claude-sonnet-5', effort: 'medium' as const } };
      const efforts = ['low', 'medium', 'high', 'xhigh'];
      const models = [
        { id: 'claude-sonnet-5', supportedReasoningEfforts: efforts },
        { id: 'claude-opus-5.5', supportedReasoningEfforts: efforts },
      ];
      const high = await play(
        { tiers, nodeModels: { pick: 'claude-opus-5.5:high' } },
        [call],
        {},
        models,
      );
      expect(high.session.cfg.model).toBe('claude-opus-5.5');
      expect(high.session.cfg.reasoningEffort).toBe('high');
      expect(high.requested).toBe(modelSettings('claude-opus-5.5', 'high'));
      // The effort recorded is the one sent.
      expect(high.res.transcript.musician).toMatchObject({ effort: 'high' });
      const kept = await play(
        { tiers, nodeModels: { pick: 'claude-opus-5.5' } },
        [call],
        {},
        models,
      );
      expect(kept.session.cfg.reasoningEffort).toBe('medium');
      expect(kept.res.transcript.musician).toMatchObject({ effort: 'medium' });
      expect(splitModelEffort('gpt-6.1-sol:xhigh')).toEqual({
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
      });
      expect(splitModelEffort('a:b')).toEqual({ model: 'a:b' });
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

  it('an empty valid answer never replaces one with content; a revision with content does', async () => {
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const skeptic: AgentPause = {
      ...pause,
      nodeId: 'skeptic',
      outputSchema: [
        { name: 'failureModes', type: 'string[]' },
        { name: 'edits', type: 'string[]' },
      ],
    };
    const play = async (calls: unknown[]) => {
      const replies: string[] = [];
      const events: ProviderEvent[] = [];
      const { client } = fakeClient(async (cfg, emit) => {
        for (const c of calls) replies.push(String(await callTool(cfg, 'submit_result', c)));
        emit('session.idle');
      });
      const res = await new CopilotProvider({ clientFactory: () => client }).runAgent({
        pause: skeptic,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
      });
      return { result: res.result, replies, events };
    };
    // As recorded: the first call's updates came as text missing its last brace, the second was empty.
    const first = {
      updates:
        '{"failureModes":["Objections never reach the answer"],"edits":["Add objections to answer.reads"]},"verdict":' +
        JSON.stringify(verdict),
    };
    const empty = { updates: { failureModes: [], edits: [] }, verdict };
    const kept = await play([first, empty]);
    expect(kept.replies[0]).toMatch(/^Result recorded/);
    expect(kept.replies[1]).toMatch(/^Not recorded: this result is empty/);
    expect(kept.result).toEqual({
      updates: {
        failureModes: ['Objections never reach the answer'],
        edits: ['Add objections to answer.reads'],
      },
      verdict,
    });
    expect(
      kept.events.some((e) => e.type === 'info' && /kept the earlier answer/.test(e.text)),
    ).toBe(true);
    // Empty first is fine; and a later answer with content still replaces an earlier one.
    expect((await play([empty])).result).toEqual(empty);
    const revised = { updates: { failureModes: ['A better one'], edits: [] }, verdict };
    expect((await play([normalizeSubmission(first), revised])).result).toEqual(revised);
    expect(hasContent({ updates: { a: [], b: '  ', c: {}, d: 0, e: false } })).toBe(false);
    expect(hasContent({ updates: { a: ['x'] } })).toBe(true);
  });

  describe('a correction that would empty what the rejected answer found', () => {
    const verdict = { outcome: 'applied', confidence: 0.6, shouldTerminate: false, reason: 'r' };
    const skeptic: AgentPause = {
      ...pause,
      nodeId: 'skeptic',
      outputSchema: [
        { name: 'failureModes', type: 'string[]' },
        { name: 'contested', type: 'string[]' },
        { name: 'edits', type: 'string[]' },
      ],
    };
    const play = async (calls: unknown[], deltaRepair = true) => {
      const replies: string[] = [];
      const { client } = fakeClient(async (cfg, emit) => {
        for (const c of calls) {
          replies.push(String(await callTool(cfg, 'submit_result', c)));
          emit('assistant.usage', { inputTokens: 10, outputTokens: 5 });
        }
        emit('session.idle');
      });
      const res = await new CopilotProvider({ clientFactory: () => client, deltaRepair }).runAgent({
        pause: skeptic,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      return { result: res.result, replies, calls: res.transcript.calls ?? [] };
    };
    // As recorded (2026-11-04T05-01-07): the findings as text with no verdict, then empty lists and a verdict.
    const rejected = {
      updates: '{"failureModes":["Nothing measures a run after the change"]}',
      contested: ['Assumption 1: maestro is in this workspace'],
      edits: ['Check first whether maestro is in the workspace'],
    };
    const emptied = { updates: { failureModes: [], contested: [], edits: [] }, verdict };
    const found = {
      failureModes: ['Nothing measures a run after the change'],
      contested: ['Assumption 1: maestro is in this workspace'],
      edits: ['Check first whether maestro is in the workspace'],
    };

    it('is refused once, so the AI can keep the content by sending only the verdict', async () => {
      const r = await play([rejected, emptied, { verdict }]);
      expect(r.replies[0]).toMatch(/^REJECTED/);
      expect(r.replies[1]).toMatch(
        /^Not recorded: this result empties contested, edits, failureModes,/,
      );
      expect(r.replies[1]).toMatch(/only the verdict/);
      expect(r.replies[2]).toMatch(/^Result recorded/);
      expect(r.result).toEqual({ updates: found, verdict });
      expect(r.calls.map((c) => c.submits)).toEqual([['rejected'], ['kept'], ['recorded']]);
    });

    it('is recorded when the AI sends it again: emptying can be meant', async () => {
      const r = await play([rejected, emptied, emptied]);
      expect(r.replies[2]).toMatch(/^Result recorded/);
      expect(r.result).toEqual(emptied);
      // Without delta repair it asks for the fields as they were.
      const full = await play([rejected, emptied], false);
      expect(full.replies[1]).toMatch(/with those fields as you had them/);
    });

    it('a correction that keeps or changes the content is recorded at once', async () => {
      const changed = { updates: { ...found, edits: ['Another edit'] }, verdict };
      expect((await play([rejected, changed])).replies[1]).toMatch(/^Result recorded/);
      expect(
        emptiedFields({ updates: { a: ['x'], b: [] } }, { updates: { a: [], b: [] } }),
      ).toEqual(['a']);
      expect(emptiedFields({ updates: { a: ['x'] } }, { updates: { b: [] } })).toEqual([]);
    });
  });

  describe('endOnSubmit', () => {
    const verdict = { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' };
    const play = async (endOnSubmit: boolean, turns: unknown[][]) => {
      const events: string[] = [];
      const { client, sessions } = fakeClient(async (cfg, emit, s) => {
        for (const turn of turns) {
          for (const c of turn) await callTool(cfg, 'submit_result', c);
          emit('assistant.usage', {
            inputTokens: 100,
            outputTokens: turn.length ? 50 : 3,
            duration: 900,
          });
          emit('assistant.turn_end');
          if (s.aborted) {
            emit('session.error', { message: 'aborted' });
            return;
          }
        }
        emit('assistant.message', { content: 'Done.' });
        emit('session.idle');
      });
      const res = await new CopilotProvider({ clientFactory: () => client, endOnSubmit }).runAgent({
        pause,
        state: {},
        visit: 0,
        signal: new AbortController().signal,
        onEvent: (e) => e.type === 'info' && events.push(e.text),
      });
      return { res, session: sessions[0]!, events };
    };
    const good = { updates: { word: 'cat' }, verdict };
    const better = { updates: { word: 'dog' }, verdict };

    it('ends the session after the turn with a valid answer: no closing call', async () => {
      const on = await play(true, [[good], []]);
      expect(on.session.aborted).toBe(true);
      expect(on.res.result).toEqual(good);
      expect(on.res.transcript.calls).toHaveLength(1);
      expect(on.res.transcript.output).toBe('');
      expect(on.events).toContain('answer recorded: ending the session without a closing call');
      const off = await play(false, [[good], []]);
      expect(off.session.aborted).toBe(false);
      expect(off.res.transcript.calls!.map((c) => c.submits ?? [])).toEqual([['recorded'], []]);
    });

    it('keeps every submission of that turn, and waits through rejected ones', async () => {
      // Parallel calls in one turn: the last valid one wins, as without the setting.
      expect((await play(true, [[good, better]])).res.result).toEqual(better);
      // A rejected answer does not end the session: the correction comes in the next turn.
      const fixed = await play(true, [[{ updates: {} }], [good], []]);
      expect(fixed.res.result).toEqual(good);
      expect(fixed.res.transcript.calls!.map((c) => c.submits)).toEqual([
        ['rejected'],
        ['recorded'],
      ]);
    });
  });

  it('repairs the verdict shapes a locate step sent (2026-11-03): no shouldTerminate, a broken JSON string', () => {
    const verdict = { outcome: 'applied', confidence: 0.5, shouldTerminate: false, reason: 'r' };
    // Left out: terminating the whole run is only ever asked for.
    expect(fixVerdict({ outcome: 'applied', confidence: 0.5, reason: 'r' })).toEqual(verdict);
    // As text.
    expect(
      fixVerdict({ outcome: 'applied', confidence: '0.5', shouldTerminate: 'false', reason: 'r' }),
    ).toEqual(verdict);
    expect(fixVerdict({ ...verdict, shouldTerminate: 'true' })).toMatchObject({
      shouldTerminate: true,
    });
    // A JSON string, valid or broken by an unescaped quote in the reason.
    expect(fixVerdict('{"confidence": 0.5, "outcome": "applied", "reason": "r"}')).toEqual(verdict);
    expect(
      fixVerdict(
        '{"confidence": 0.5, "outcome": "applied", "reason": "The checker rejected "src/a b.ts" twice"}',
      ),
    ).toEqual({ ...verdict, reason: 'The checker rejected "src/a b.ts" twice' });
    // Nothing to go on: left for the schema to reject.
    expect(fixVerdict('looks fine')).toBe('looks fine');
    expect(fixVerdict({ confidence: 1 })).toMatchObject({ shouldTerminate: false });
  });

  it('repairs updates sent as text in every shape recorded from Claude models, deterministically', () => {
    const verdict = { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'r' };
    const v = JSON.stringify(verdict);
    // The whole result with its {"updates": cut off (deepRead, propose).
    expect(
      normalizeSubmission({
        updates: `{\n"examined": ["a.ts"],\n"newFindings": ["a.ts:1 — x"]\n},"verdict":${v}}`,
      }),
    ).toEqual({
      updates: { examined: ['a.ts'], newFindings: ['a.ts:1 — x'] },
      verdict,
    });
    // ...and also its last brace (skeptic).
    expect(normalizeSubmission({ updates: `{"failureModes":["f"]},"verdict":${v}` })).toEqual({
      updates: { failureModes: ['f'] },
      verdict,
    });
    // An object never closed, its other fields sent beside it (plan, hypothesize, triage).
    expect(
      normalizeSubmission({
        updates: '{"subQuestions":["q1","q2"]',
        searchTerms: ['t'],
        useSources: ['workspace'],
        verdict,
      }),
    ).toEqual({
      updates: { subQuestions: ['q1', 'q2'], searchTerms: ['t'], useSources: ['workspace'] },
      verdict,
    });
    // Tool-call markup, with the verdict as markup or flattened beside it (deepRead, sweep).
    expect(
      normalizeSubmission({
        updates: '\n<parameter name="examined">["README.md", "AGENTS.md"]',
        newFindings: ['README.md:1 — y'],
        verdict,
      }),
    ).toEqual({
      updates: { examined: ['README.md', 'AGENTS.md'], newFindings: ['README.md:1 — y'] },
      verdict,
    });
    expect(
      normalizeSubmission({
        updates: '<parameter name="queries">["git log"]</parameter>',
        outcome: 'applied',
        confidence: 0.9,
        shouldTerminate: false,
        reason: 'r',
      }),
    ).toEqual({ updates: { queries: ['git log'] }, verdict });
    // Trailing commas, one closing brace too many, cut off after a list (triage, deepRead, chase).
    expect(normalizeSubmission({ updates: '{"triaged": ["a.ts", "b.ts"],\n}', verdict })).toEqual({
      updates: { triaged: ['a.ts', 'b.ts'] },
      verdict,
    });
    expect(
      normalizeSubmission({ updates: '{"examined":["a.ts"],"unreadable":[]\n},\n', verdict }),
    ).toEqual({
      updates: { examined: ['a.ts'], unreadable: [] },
      verdict,
    });
    expect(
      normalizeSubmission({ updates: '{"queries":["q"],"newFindings":["n"],', verdict }),
    ).toEqual({
      updates: { queries: ['q'], newFindings: ['n'] },
      verdict,
    });
    // The verdict inside updates (experiment): lifted out, it can never be a state field.
    expect(normalizeSubmission({ updates: `{"queries":["npm test"],"verdict":${v}}}` })).toEqual({
      updates: { queries: ['npm test'] },
      verdict,
    });
    // Fields named in updates win over strays; prose is left for the schema to reject.
    expect(normalizeSubmission({ updates: '{"a":1', a: 2, verdict })).toEqual({
      updates: { a: 1 },
      verdict,
    });
    expect(
      normalizeSubmission({ updates: 'I looked at the files and found nothing.', verdict }),
    ).toEqual({
      updates: 'I looked at the files and found nothing.',
      verdict,
    });
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
    // Each call carries what it was billed, for comparing with its cached tokens.
    expect(res.transcript.calls?.map((c) => c.nanoAiu)).toEqual([2000, 2000]);
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
      replies.push(await callTool(cfg, 'submit_result', { updates: 'the word is x' }));
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

  it('offers kusto_query to steps that may read outside the workspace, read-only', async () => {
    const asked: string[] = [];
    const { client, sessions } = fakeClient(async (cfg, emit) => {
      if (cfg.tools!.some((t) => t.name === 'kusto_query')) {
        for (const query of ['T | count', '.drop table T'])
          emit('assistant.message', {
            content: String(
              await callTool(cfg, 'kusto_query', { cluster: 'c', database: 'd', query }),
            ),
          });
      }
      await callTool(cfg, 'submit_result', { updates: { word: 'x' } });
      emit('session.idle');
    });
    const p = new CopilotProvider({
      clientFactory: () => client,
      kusto: {
        token: async () => 'tok',
        fetch: (async (_url: string, init: RequestInit) => {
          asked.push(String(init.body));
          return new Response(
            JSON.stringify({ Tables: [{ Columns: [{ ColumnName: 'n' }], Rows: [[7]] }] }),
          );
        }) as unknown as typeof fetch,
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
    const out = await go(['mcp']);
    expect(out.transcript.output).toContain('n\n7');
    expect(out.transcript.output).toContain('kusto_query refused: `.drop table`');
    expect(asked).toEqual([JSON.stringify({ db: 'd', csl: 'T | count' })]);
    expect(out.transcript.prompt).toContain('kusto_query(cluster, database, query)');
    await go([]);
    expect(sessions[1]!.cfg.tools!.map((t) => t.name)).toEqual(['submit_result']);
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
    expect(perf.outcome).toBe('partial');
    expect(sessions).toHaveLength(3);
    const rejected = perf.events.filter((e) => e.type === 'response-rejected');
    expect(rejected).toHaveLength(3);
    expect(perf.finalState.examined).toEqual([]);
    expect(perf.reason).toMatch(/deepRead.*verdict is missing/);
  });
});

const localReq = (p: AgentPause = pause) => ({
  pause: p,
  state: {},
  visit: 0,
  signal: new AbortController().signal,
  onEvent: () => {},
});

/** A model server that lists one model, for the time a test needs it. */
async function modelServer(id = 'openai/gpt-oss-120b') {
  const http = await import('node:http');
  const server = http.createServer((q, r) => {
    r.writeHead(q.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ data: [{ id }] }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}
/** Nothing listens there: refused at once. */
const DOWN = 'http://127.0.0.1:1/v1';

describe('a local model server instead of Copilot', () => {
  /** A session that submits a valid result, on whatever model it was given. */
  const submitting = () =>
    fakeClient(async (cfg, emit) => {
      await callTool(cfg, 'submit_result', {
        updates: { word: 'cat' },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      });
      emit('assistant.message', { content: 'Done.', model: String(cfg.model) });
      emit('session.idle');
    });

  it('every step plays on its model, through its endpoint, with no sign-in and no effort', async () => {
    const server = await modelServer();
    try {
      const { client, sessions } = submitting();
      let asked = false;
      const p = new CopilotProvider({
        clientFactory: () => ({
          ...client,
          // Copilot would say nobody is signed in: a local model never asks.
          getAuthStatus: async () => ((asked = true), { isAuthenticated: false }),
        }),
        localModel: { baseUrl: server.url, apiKey: 'k', model: 'openai/gpt-oss-120b' },
      });
      for (const complexity of [1, 4] as const)
        await p.runAgent(localReq({ ...pause, complexity }));
      expect(asked).toBe(false);
      for (const s of sessions) {
        expect(s.cfg.model).toBe('openai/gpt-oss-120b');
        expect(s.cfg.reasoningEffort).toBeUndefined();
        expect(s.cfg.excludedTools).toEqual(expect.arrayContaining(['task', 'sql', 'skill']));
        expect(s.cfg.provider).toEqual({
          type: 'openai',
          baseUrl: server.url,
          apiKey: 'k',
        });
      }
      expect((await p.authStatus()).message).toBe(`local model server ${server.url}`);
    } finally {
      server.close();
    }
  });

  it('with no model named, the first the server lists', async () => {
    const http = await import('node:http');
    const server = http.createServer((q, r) => {
      r.writeHead(q.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ data: [{ id: 'Qwen/Qwen3.8-27B' }] }));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const { port } = server.address() as { port: number };
      const { client, sessions } = submitting();
      const p = new CopilotProvider({
        clientFactory: () => client,
        localModel: { baseUrl: `http://127.0.0.1:${port}/v1/` },
      });
      await p.runAgent(localReq());
      expect(sessions[0]!.cfg.model).toBe('Qwen/Qwen3.8-27B');
      // A server that is not there says so, at setup.
      const gone = new CopilotProvider({
        clientFactory: () => client,
        localModel: { baseUrl: 'http://127.0.0.1:1/v1' },
      });
      await expect(gone.runAgent(localReq())).rejects.toThrow(/did not answer/);
    } finally {
      server.close();
    }
  });

  it('without sign-ins and no model server, it refuses rather than run as your Copilot account', async () => {
    const { client, sessions } = submitting();
    const p = new CopilotProvider({
      clientFactory: () => ({ ...client, getAuthStatus: async () => ({ isAuthenticated: true }) }),
      signIns: false,
    });
    await expect(p.runAgent(localReq())).rejects.toThrow(/SYMPHONY_MODEL_URL/);
    expect(sessions).toHaveLength(0);
  });

  it('without sign-ins, the Kusto tool (your Azure sign-in) is not offered', async () => {
    const server = await modelServer('m1');
    const web = { ...pause, capabilities: ['web'] as AgentPause['capabilities'] };
    const tools = async (signIns?: boolean) => {
      const { client, sessions } = submitting();
      await new CopilotProvider({
        clientFactory: () => client,
        localModel: { baseUrl: server.url, model: 'm1' },
        ...(signIns === false ? { signIns } : {}),
      }).runAgent(localReq(web));
      return sessions[0]!.cfg.tools!.map((t) => t.name);
    };
    expect(await tools()).toContain(KUSTO_TOOL);
    expect(await tools(false)).not.toContain(KUSTO_TOOL);
    server.close();
  });

  it('a server that does not answer: Copilot when it may fall back, else a setup error at once', async () => {
    // May fall back (sign-ins allowed): Copilot plays, and the run says why.
    const { client, sessions } = submitting();
    const events: ProviderEvent[] = [];
    const p = new CopilotProvider({
      clientFactory: () => ({ ...client, getAuthStatus: async () => ({ isAuthenticated: true }) }),
      model: 'claude-sonnet-5.5',
      localModel: { baseUrl: DOWN, model: 'openai/gpt-oss-120b', fallback: true },
    });
    await p.runAgent({ ...localReq(), onEvent: (e) => events.push(e) });
    expect(sessions[0]!.cfg.provider).toBeUndefined();
    expect(sessions[0]!.cfg.model).toBe('claude-sonnet-5.5');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'info',
        text: expect.stringMatching(/did not answer.*using GitHub Copilot/),
      }),
    );
    // No fallback: stopped before any session, not left retrying.
    const none = submitting();
    const strict = new CopilotProvider({
      clientFactory: () => none.client,
      localModel: { baseUrl: DOWN, model: 'openai/gpt-oss-120b' },
    });
    await expect(strict.runAgent(localReq())).rejects.toThrow(/did not answer/);
    expect((await strict.authStatus()).signedIn).toBe(false);
    // Without sign-ins (a run from another machine), never Copilot, fallback or not.
    const remote = new CopilotProvider({
      clientFactory: () => none.client,
      signIns: false,
      localModel: { baseUrl: DOWN, model: 'openai/gpt-oss-120b', fallback: true },
    });
    await expect(remote.runAgent(localReq())).rejects.toThrow(/did not answer/);
    expect(none.sessions).toHaveLength(0);
  });
});
