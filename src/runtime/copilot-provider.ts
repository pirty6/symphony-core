/**
 * Copilot SDK provider: one fresh session per agent node.
 *
 *   - structured output through a `submit_result` tool whose JSON schema is
 *     derived from the node's `writes` (the engine still re-validates)
 *   - assessors are kept read-only by the permission handler
 *   - deltas, reasoning, tool calls and permission decisions stream to the UI
 *   - AbortSignal aborts the live session (stop mid-node)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient, defineTool, ToolSet } from '@github/copilot-sdk';
import type { MCPServerConfig, SessionConfig } from '@github/copilot-sdk';
import { webSearch, type SearchResult } from './web-search.js';
import { acceptance, isProviderBlock } from '../core/engine.js';
import { checkAgentResult, resultJsonSchema } from '../core/schema.js';
import { addUsage } from '../core/usage.js';
import { checkCitations } from './evidence.js';
import { stepTimeLimitMs } from './limits.js';
import type { AgentPause, Complexity, Role, TokenUsage, ToolCallRecord } from '../core/types.js';
import type {
  AgentRequest,
  AgentResponse,
  DraftRequest,
  Provider,
  ProviderEvent,
} from './provider.js';
import {
  buildAgentPrompt,
  buildIntegrationPrompt,
  decidePermission,
  extractJson,
  SUBMIT_TOOL,
} from './provider.js';

export const DRAFT_TOOL = 'submit_draft';
export const WEB_SEARCH_TOOL = 'web_search';

export interface SessionLike {
  on(handler: (event: { type: string; data?: unknown }) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ClientLike {
  start(): Promise<void>;
  createSession(config: SessionConfig): Promise<SessionLike>;
  stop(): Promise<unknown>;
  getAuthStatus?(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }>;
}

/** Copilot cannot be used as configured: no retry can help, so the run stops with this. */
export class SetupError extends Error {
  override name = 'SetupError';
}

/** What to do when no GitHub account is signed in for Copilot. */
export const SIGN_IN_HELP =
  'Copilot is not signed in on this machine. Run `npm run login` in a terminal (it signs in your GitHub account; Copilot access is required), or put COPILOT_GITHUB_TOKEN=<a fine-grained token with the "Copilot Requests" permission> in .env. Then run again. The offline demo (AI: Scripted) works without signing in.';

const NOT_SIGNED_IN =
  /No GitHub OAuth token|Copilot HMAC key|not authenticated|authentication required/i;
/** Signed in, but Copilot refuses the credential (no Copilot access, or a token that cannot use it). */
const REFUSED = /Authorization error|you may need to run \/login|\b401\b|Unauthorized/i;

/** The account's Copilot quota is used up: every model refuses until it resets. */
const QUOTA =
  /exceeded your (monthly )?quota|quota (has been |was )?exceeded|out of premium requests/i;

/** What to do when the Copilot quota is used up. */
export function quotaHelp(said: string): string {
  return `Your Copilot quota is used up, so no model will answer (Copilot said: ${said.replace(/^\[|\]$/g, '').trim()}). Wait for it to reset, or raise your premium-request budget in your GitHub Copilot settings (https://github.com/settings/copilot). Retrying cannot help. The offline demo (AI: Scripted) still works.`;
}

/** Copilot token variables, which the CLI would otherwise prefer over the signed-in account. */
export function withoutTokenVars(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const { COPILOT_GITHUB_TOKEN: _a, GH_TOKEN: _b, GITHUB_TOKEN: _c, ...rest } = env;
  return rest;
}

/** What to do when Copilot refuses the account that is signed in. */
export function refusedHelp(login?: string): string {
  return `Copilot refused the GitHub account signed in on this machine${login ? ` (${login})` : ''}. Check that it has Copilot (https://github.com/settings/copilot) and that your organization allows Copilot in the CLI, then run \`npm run login\` again. The offline demo (AI: Scripted) works without it.`;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface Tier {
  readonly model: string;
  readonly effort?: ReasoningEffort;
}

/** Default model per complexity tier (overridable with SYMPHONY_TIERS). */
export const DEFAULT_TIERS: Readonly<Record<Complexity, Tier>> = {
  1: { model: 'claude-haiku-5.5', effort: 'low' },
  2: { model: 'claude-sonnet-5', effort: 'medium' },
  3: { model: 'claude-sonnet-5.5', effort: 'high' },
  4: { model: 'claude-opus-5.5', effort: 'xhigh' },
};

/** Parse "1=model:effort,2=model,..." into tiers. */
export function parseTiers(spec: string | undefined): Partial<Record<Complexity, Tier>> {
  const out: Partial<Record<Complexity, Tier>> = {};
  for (const part of (spec ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^([1-4])\s*=\s*([^:\s]+)(?::(low|medium|high|xhigh))?$/.exec(part);
    if (!m) throw new Error(`invalid tier '${part}' (expected N=model[:low|medium|high|xhigh])`);
    out[Number(m[1]) as Complexity] = {
      model: m[2]!,
      ...(m[3] ? { effort: m[3] as ReasoningEffort } : {}),
    };
  }
  return out;
}

export interface CopilotProviderOptions {
  /** Forces one model for every tier (overrides `tiers`). */
  readonly model?: string;
  /** Model per complexity tier; defaults to DEFAULT_TIERS. */
  readonly tiers?: Partial<Record<Complexity, Tier>>;
  /** For steps that want another model family (otherModel); default gpt-6.1-sol. */
  readonly alternateModel?: string;
  readonly workingDirectory?: string;
  /** MCP servers connected to nodes with the 'mcp' capability. */
  readonly mcpServers?: Readonly<Record<string, MCPServerConfig>>;
  /** Backend for the web_search tool (nodes with the 'web' capability). */
  readonly webSearch?: (query: string, signal: AbortSignal) => Promise<readonly SearchResult[]>;
  readonly gitHubToken?: string;
  /** Where the token was set (e.g. TOKEN), named in messages when Copilot refuses it. */
  readonly gitHubTokenSource?: string;
  /** Safety net per call; default a minute after the step limit the driver enforces (limits.ts). */
  readonly timeoutMs?: number;
  /** Builds the SDK client; `gitHubToken` is undefined when using the signed-in GitHub user. */
  readonly clientFactory?: (auth: { readonly gitHubToken?: string }) => ClientLike;
  readonly clock?: () => string;
}

interface SessionRun {
  readonly prompt: string;
  readonly role: Role;
  readonly tools: readonly ReturnType<typeof defineTool>[];
  readonly onlyCustomTools: boolean;
  readonly mcpServers?: Readonly<Record<string, MCPServerConfig>>;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  /** Tier the model came from; re-resolved if the client changes (token fallback). */
  readonly complexity?: Complexity;
  readonly signal: AbortSignal;
  readonly onEvent: (e: ProviderEvent) => void;
}

/** '@github/copilot-sdk@x.y.z', read once from the installed package. */
const SDK = (() => {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve('@github/copilot-sdk')));
    for (let i = 0; i < 4; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@github/copilot-sdk') return `${pkg.name}@${pkg.version}`;
      } catch {
        // keep walking up
      }
    }
  } catch {
    // not resolvable (e.g. bundled): leave it out
  }
  return undefined;
})();

export const SAMPLING_NOTE =
  'provider default: the Copilot SDK does not expose seed or temperature; use classical mode (recorded answers) for identical notes';

const DEFAULT_ALTERNATE = 'gpt-6.1-sol';
/** 'claude-sonnet-5' -> 'claude'. */
const family = (model: string) => model.split('-')[0];

/** System prompt for sessions with only Symphony's own tools (no workspace, files or shell). */
export const ISOLATED_SYSTEM = [
  'You work on one step of a deterministic workflow, inside a session with no workspace, files or shell.',
  'Use only the tools you are given (always submit_result; web_search and web_fetch when listed).',
  'Reason only from what the user message gives you and what those tools return. Never invent facts, file contents, line numbers or citations; say what you do not know.',
  'Finish by calling submit_result exactly once with the requested JSON. Make one tool call at a time, never several in parallel. Tool arguments are JSON values: `updates` is a JSON object (not a string) with exactly the listed keys, and lists are JSON arrays.',
].join('\n');

const checkErrors = (c: { ok: boolean; errors?: readonly string[] }) =>
  c.ok ? [] : [...(c.errors ?? [])];

/**
 * Repair the commonest malformed submission before judging it: `updates` (or the
 * whole result) sent as a JSON string instead of an object.
 */
function parseObject(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : v;
  } catch {
    return v;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const tryObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const o = JSON.parse(text) as unknown;
    return isRecord(o) ? o : undefined;
  } catch {
    return undefined;
  }
};

/** `<parameter name="k">value` blocks (the AI wrote tool-call markup into a string). */
function fromParameterMarkup(text: string): Record<string, unknown> | undefined {
  const blocks = [
    ...text.matchAll(
      /<parameter name="([\w-]+)">\s*([\s\S]*?)\s*(?:<\/parameter>|(?=<parameter name=")|$)/g,
    ),
  ];
  if (blocks.length === 0) return undefined;
  return Object.fromEntries(
    blocks.map(([, key, value]) => {
      try {
        return [key, JSON.parse(value!) as unknown];
      } catch {
        return [key, value];
      }
    }),
  );
}

/** Trailing commas before a closing bracket or at the end (the commonest near-JSON slip). */
const withoutTrailingCommas = (t: string) => t.replace(/,(\s*[}\]])/g, '$1').replace(/,\s*$/, '');

/**
 * `updates` sent as text, repaired deterministically (recorded Claude payloads):
 * the whole result with its `{"updates":` cut off, sometimes also its last `}`; an
 * object never closed or closed once too often, its other fields sent beside it;
 * trailing commas; or tool-call markup. Returns the updates and, when the text held
 * the whole result, its other parts. The schema still judges whatever comes out.
 */
function repairUpdates(
  text: string,
): { updates: Record<string, unknown>; rest: Record<string, unknown> } | undefined {
  for (const t of [text, withoutTrailingCommas(text)]) {
    const asIs = tryObject(t);
    if (asIs) return { updates: asIs, rest: {} };
    for (const whole of [`{"updates":${t}`, `{"updates":${t}}`]) {
      const o = tryObject(whole);
      if (o && isRecord(o.updates)) {
        const { updates, ...rest } = o;
        return { updates, rest };
      }
    }
    const closed = tryObject(`${t}}`) ?? tryObject(t.replace(/}\s*$/, ''));
    if (closed) return { updates: closed, rest: {} };
  }
  const markup = fromParameterMarkup(text);
  return markup ? { updates: markup, rest: {} } : undefined;
}

/** A verdict sent as JSON text or as tool-call markup, as an object. */
function repairVerdict(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return tryObject(v) ?? fromParameterMarkup(v) ?? v;
}

const RESULT_KEYS = new Set(['updates', 'verdict', 'next']);
const VERDICT_KEYS = new Set(['outcome', 'confidence', 'shouldTerminate', 'reason']);

/**
 * Repair the shapes a submission arrives in before the schema judges it: the
 * result or `updates` as a JSON string, `updates` as broken text (repairUpdates),
 * update fields sent beside `updates`, verdict fields sent beside `verdict`'s place.
 * Anything still wrong is left for the schema check to reject.
 */
export function normalizeSubmission(raw: unknown): unknown {
  const r = parseObject(raw);
  if (!isRecord(r) || !('updates' in r)) return r;
  let updates = parseObject(r.updates);
  let outer: Record<string, unknown> = r;
  if (typeof updates === 'string') {
    const repaired = repairUpdates(updates);
    if (!repaired) return { ...r, updates };
    updates = repaired.updates;
    outer = { ...repaired.rest, ...r };
  }
  if (!isRecord(updates)) return { ...outer, updates };
  // verdict and next can never be state fields: inside updates, they were misplaced.
  const { verdict: innerVerdict, next: innerNext, ...fields } = updates;
  if (outer.verdict === undefined && innerVerdict !== undefined)
    outer = { ...outer, verdict: innerVerdict };
  if (outer.next === undefined && innerNext !== undefined) outer = { ...outer, next: innerNext };
  const strays = Object.entries(outer).filter(([k]) => !RESULT_KEYS.has(k) && !VERDICT_KEYS.has(k));
  const flatVerdict = Object.fromEntries(
    Object.entries(outer).filter(([k]) => VERDICT_KEYS.has(k)),
  );
  const verdict =
    repairVerdict(outer.verdict) ?? (Object.keys(flatVerdict).length > 0 ? flatVerdict : undefined);
  return {
    // Fields named in updates win over strays of the same name.
    updates: { ...Object.fromEntries(strays), ...fields },
    ...(verdict !== undefined ? { verdict } : {}),
    ...('next' in outer ? { next: outer.next } : {}),
  };
}

/** Keep the record small: optional measurements the provider never reported are left out. */
function withoutZeros(u: TokenUsage): TokenUsage {
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(u))
    if (
      v !== 0 ||
      ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens'].includes(key)
    )
      out[key] = v as number;
  return out as unknown as TokenUsage;
}

/** Whether an answer says anything: some text, list or object in its updates is filled. */
export function hasContent(result: unknown): boolean {
  const updates = isRecord(result) ? result.updates : undefined;
  if (!isRecord(updates)) return false;
  return Object.values(updates).some((v) =>
    typeof v === 'string'
      ? v.trim() !== ''
      : Array.isArray(v)
        ? v.length > 0
        : isRecord(v) && Object.keys(v).length > 0,
  );
}

/** In-session retries of a malformed submit_result before the engine judges it. */
const MAX_SUBMIT_CORRECTIONS = 2;

const abortError = () => new DOMException('aborted', 'AbortError');

export class CopilotProvider implements Provider {
  readonly name = 'copilot';
  private readonly opts: CopilotProviderOptions;
  private client: ClientLike | undefined;
  private starting: Promise<ClientLike> | undefined;
  /** Set once the configured token is rejected; from then on the signed-in user is used. */
  private tokenRejected = false;

  constructor(opts: CopilotProviderOptions = {}) {
    this.opts = opts;
  }

  private ensureClient(): Promise<ClientLike> {
    if (this.client) return Promise.resolve(this.client);
    this.starting ??= (async () => {
      const token = this.tokenRejected ? undefined : this.opts.gitHubToken;
      const auth = token ? { gitHubToken: token } : {};
      const client =
        this.opts.clientFactory?.(auth) ??
        (new CopilotClient(
          token
            ? auth
            : // The CLI prefers token variables over a sign-in: hide them so the sign-in is used.
              { useLoggedInUser: true, env: withoutTokenVars(process.env) },
        ) as unknown as ClientLike);
      await client.start();
      this.client = client;
      return client;
    })();
    return this.starting;
  }

  private signInChecked = false;

  /** Who Copilot runs as here, or why it cannot run (no GitHub account signed in). */
  async authStatus(): Promise<{
    signedIn: boolean;
    login?: string;
    message: string;
    /** The token variable used instead of the signed-in account, when one is set. */
    tokenSource?: string;
  }> {
    const client = await this.ensureClient();
    const source =
      this.opts.gitHubToken && !this.tokenRejected && this.opts.gitHubTokenSource
        ? { tokenSource: this.opts.gitHubTokenSource }
        : {};
    if (!client.getAuthStatus)
      return { signedIn: true, message: 'unknown (not reported)', ...source };
    const s = await client.getAuthStatus();
    return s.isAuthenticated
      ? {
          signedIn: true,
          ...(s.login ? { login: s.login } : {}),
          message: s.statusMessage ?? '',
          ...source,
        }
      : { signedIn: false, message: SIGN_IN_HELP, ...source };
  }

  private async runSession(
    run: SessionRun,
  ): Promise<{ output: string; toolCalls: ToolCallRecord[]; model?: string; usage?: TokenUsage }> {
    if (run.signal.aborted) throw abortError();
    if (!this.signInChecked) {
      let status = await this.authStatus().catch(() => undefined);
      // A configured token that is not accepted: try the account signed in on this machine.
      if (status && !status.signedIn && this.opts.gitHubToken && !this.tokenRejected) {
        this.tokenRejected = true;
        run.onEvent({
          type: 'info',
          text: `the token in ${this.opts.gitHubTokenSource ?? 'your settings'} is not signed in to Copilot; using the GitHub account signed in on this machine instead`,
        });
        await this.dropClient();
        status = await this.authStatus().catch(() => undefined);
      }
      if (status && !status.signedIn) throw new SetupError(SIGN_IN_HELP);
      this.signInChecked = status !== undefined;
    }
    const client = await this.ensureClient();
    if (run.signal.aborted) throw abortError();
    const toolCalls: ToolCallRecord[] = [];
    const config: SessionConfig = {
      ...(run.model ? { model: run.model } : {}),
      ...(run.effort ? { reasoningEffort: run.effort } : {}),
      ...(this.opts.workingDirectory ? { workingDirectory: this.opts.workingDirectory } : {}),
      tools: [...run.tools],
      ...(run.onlyCustomTools
        ? {
            availableTools: run.tools.reduce((set, t) => set.addCustom(t.name), new ToolSet()),
            // The SDK's own system prompt (~4k tokens) is about workspace tools this
            // session cannot use; a short one says what it can do.
            systemMessage: { mode: 'replace', content: ISOLATED_SYSTEM },
          }
        : { excludedTools: ['task'] }),
      ...(run.mcpServers && Object.keys(run.mcpServers).length > 0
        ? { mcpServers: { ...run.mcpServers } }
        : {}),
      skipCustomInstructions: true,
      onPermissionRequest: (request) => {
        const decision = decidePermission(
          run.role,
          request as Parameters<typeof decidePermission>[1],
        );
        run.onEvent({
          type: 'permission',
          kind: request.kind,
          allowed: decision.allowed,
          detail: decision.reason,
        });
        if (!decision.allowed) toolCalls.push({ name: request.kind, denied: decision.reason });
        return decision.allowed
          ? { kind: 'approve-once' }
          : { kind: 'reject', feedback: decision.reason };
      },
    };
    let session: SessionLike;
    try {
      session = await client.createSession(config);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/auth/i.test(msg)) throw e;
      if (this.opts.gitHubToken && !this.tokenRejected) {
        // The configured token is bad: fall back to the signed-in GitHub user (VS Code / Copilot CLI / gh login).
        this.tokenRejected = true;
        run.onEvent({
          type: 'info',
          text: 'Configured token was rejected; falling back to your signed-in GitHub user.',
        });
        await this.dropClient();
        if (run.complexity === undefined) return this.runSession(run);
        // The new account may offer different models: resolve the tier again.
        const tier = await this.modelFor(run.complexity);
        if (tier.note) run.onEvent({ type: 'info', text: tier.note });
        const { model: _m, effort: _e, ...rest } = run;
        return this.runSession({
          ...rest,
          ...(tier.model ? { model: tier.model } : {}),
          ...(tier.effort ? { effort: tier.effort } : {}),
        });
      }
      throw new Error(
        `${msg}. ${
          this.tokenRejected
            ? 'Both the configured token and your signed-in GitHub user were rejected: sign in with VS Code, the Copilot CLI or `gh auth login`, or fix GITHUB_TOKEN / TOKEN in .env.'
            : 'Sign in with VS Code, the Copilot CLI or `gh auth login`, or set GITHUB_TOKEN in .env.'
        }`,
        { cause: e },
      );
    }
    let output = '';
    let model: string | undefined;
    let failure: string | undefined;
    const usage = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      cacheWriteTokens: 0,
      apiMs: 0,
      firstTokenMs: 0,
      premiumRequests: 0,
      nanoAiu: 0,
      compactions: 0,
    };
    const names = new Map<string, string>();
    let settle!: () => void;
    const idle = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const off = session.on((event) => {
      const d = (event.data ?? {}) as Record<string, unknown>;
      switch (event.type) {
        case 'assistant.message_delta':
          run.onEvent({ type: 'delta', text: String(d.deltaContent ?? '') });
          break;
        case 'assistant.reasoning_delta':
          run.onEvent({ type: 'reasoning', text: String(d.deltaContent ?? '') });
          break;
        case 'assistant.message':
          if (typeof d.content === 'string' && d.content) {
            output += (output ? '\n' : '') + d.content;
            run.onEvent({ type: 'message', text: d.content });
          }
          if (typeof d.model === 'string') model = d.model;
          break;
        case 'tool.execution_start': {
          const id = String(d.toolCallId ?? '');
          const name = String(d.toolName ?? 'tool');
          names.set(id, name);
          toolCalls.push({ name, args: d.arguments });
          run.onEvent({ type: 'tool-start', id, name, args: d.arguments });
          break;
        }
        case 'tool.execution_complete': {
          const id = String(d.toolCallId ?? '');
          run.onEvent({
            type: 'tool-end',
            id,
            name: names.get(id) ?? 'tool',
            ok: d.success === true,
          });
          break;
        }
        case 'assistant.usage': {
          const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
          usage.calls += 1;
          usage.inputTokens += n('inputTokens');
          usage.outputTokens += n('outputTokens');
          usage.cacheReadTokens += n('cacheReadTokens');
          usage.reasoningTokens += n('reasoningTokens');
          usage.cacheWriteTokens += n('cacheWriteTokens');
          usage.apiMs += n('duration');
          usage.firstTokenMs += n('timeToFirstTokenMs');
          usage.premiumRequests += n('cost');
          usage.nanoAiu += Number(
            (d.copilotUsage as { totalNanoAiu?: unknown } | undefined)?.totalNanoAiu ?? 0,
          );
          break;
        }
        case 'session.compaction_complete':
          usage.compactions += 1;
          run.onEvent({ type: 'info', text: 'the conversation was compacted to fit the context' });
          break;
        case 'session.error':
          failure = String(d.message ?? 'session error');
          run.onEvent({ type: 'info', text: `error: ${failure}` });
          settle();
          break;
        case 'session.idle':
          settle();
          break;
      }
    });
    const onAbort = () => {
      void session.abort().catch(() => {});
      settle();
    };
    run.signal.addEventListener('abort', onAbort, { once: true });
    if (run.signal.aborted) {
      // Stop arrived while the session was being created: never send the prompt.
      off();
      run.signal.removeEventListener('abort', onAbort);
      await session.disconnect().catch(() => {});
      throw abortError();
    }
    const timeoutMs = this.opts.timeoutMs ?? stepTimeLimitMs() + 60_000;
    const timer = setTimeout(() => {
      failure = `timed out after ${timeoutMs} ms`;
      void session.abort().catch(() => {});
      settle();
    }, timeoutMs);
    try {
      await session.send({ prompt: run.prompt });
      await idle;
    } finally {
      clearTimeout(timer);
      run.signal.removeEventListener('abort', onAbort);
      off();
      await session.disconnect().catch(() => {});
    }
    if (run.signal.aborted) throw abortError();
    if (failure && !output) output = `[${failure}]`;
    // Without a GitHub account the CLI answers with an error message, not a model reply.
    if (toolCalls.length === 0 && NOT_SIGNED_IN.test(output)) throw new SetupError(SIGN_IN_HELP);
    if (toolCalls.length === 0 && REFUSED.test(output)) return this.refused(run, output);
    if (toolCalls.length === 0 && QUOTA.test(output)) throw new SetupError(quotaHelp(output));
    return {
      output,
      toolCalls,
      ...(model ? { model } : {}),
      ...(usage.calls ? { usage: withoutZeros(usage) } : {}),
    };
  }

  /** Resolve the model and reasoning effort for a tier, checked against the models available. */
  async modelFor(
    complexity: Complexity,
  ): Promise<{ model?: string; effort?: ReasoningEffort; note?: string }> {
    const available = await this.availableModels();
    const forced = this.opts.model;
    if (forced && (!available || available.has(forced))) return { model: forced };
    // A forced model this account cannot use would fail every call: fall back to the tiers.
    const skipped = forced ? `model '${forced}' (MODEL) is not available to you; ` : '';
    const tier = { ...DEFAULT_TIERS, ...this.opts.tiers }[complexity];
    if (available && !available.has(tier.model)) {
      return {
        note: `${skipped}tier ${complexity} model '${tier.model}' is not available to you; using the default model`,
      };
    }
    const efforts = available?.get(tier.model);
    const effort =
      tier.effort && (!efforts || efforts.includes(tier.effort)) ? tier.effort : undefined;
    return {
      model: tier.model,
      ...(effort ? { effort } : {}),
      ...(skipped ? { note: `${skipped}using tier ${complexity} '${tier.model}'` } : {}),
    };
  }

  /** The alternate model when it is available and from another family than the tier's. */
  private async otherFamily(
    complexity: Complexity,
  ): Promise<{ model?: string; effort?: ReasoningEffort; note?: string }> {
    const base = await this.modelFor(complexity);
    const want = this.opts.alternateModel ?? DEFAULT_ALTERNATE;
    const available = await this.availableModels();
    if (!base.model || family(base.model) === family(want) || (available && !available.has(want))) {
      return {
        ...base,
        note: `no model from another family is available (${want}); using ${base.model ?? 'the default model'}`,
      };
    }
    const efforts = available?.get(want);
    return {
      model: want,
      ...(base.effort && (!efforts || efforts.includes(base.effort))
        ? { effort: base.effort }
        : {}),
      note: `second opinion on ${want}, another model family than ${base.model}`,
    };
  }

  /** Citations in the step's `cites` field that the workspace does not back up. */
  private async citationErrors(
    pause: AgentPause,
    updates: Readonly<Record<string, unknown>>,
  ): Promise<string[]> {
    const cited = pause.cites ? updates[pause.cites] : undefined;
    if (!this.opts.workingDirectory || !Array.isArray(cited)) return [];
    const r = await checkCitations(
      this.opts.workingDirectory,
      cited.filter((c): c is string => typeof c === 'string'),
    );
    return r.invalid.map(
      (i) =>
        `${pause.cites}: "${i.finding.slice(0, 120)}" — ${i.reason}. Fix the path, line or quote from the file, or remove it.`,
    );
  }

  /** Up to two other models, from the nearest tiers, for when a content filter blocks one. */
  private async otherModels(
    complexity: Complexity,
    current: string | undefined,
  ): Promise<{ model: string; effort?: ReasoningEffort }[]> {
    const available = await this.availableModels();
    const table = { ...DEFAULT_TIERS, ...this.opts.tiers };
    const seen = new Set([current]);
    const out: { model: string; effort?: ReasoningEffort }[] = [];
    for (const d of [-1, 1, -2, 2, -3, 3]) {
      const t = complexity + d;
      if (t < 1 || t > 4 || out.length >= 2) continue;
      const { model, effort } = table[t as Complexity];
      if (seen.has(model) || (available && !available.has(model))) continue;
      seen.add(model);
      const efforts = available?.get(model);
      out.push({ model, ...(effort && (!efforts || efforts.includes(effort)) ? { effort } : {}) });
    }
    return out;
  }

  private models: Promise<Map<string, readonly string[]> | undefined> | undefined;

  private availableModels(): Promise<Map<string, readonly string[]> | undefined> {
    this.models ??= (async () => {
      try {
        const client = (await this.ensureClient()) as ClientLike & {
          listModels?: () => Promise<unknown[]>;
        };
        if (!client.listModels) return undefined;
        const list = (await client.listModels()) as {
          id: string;
          supportedReasoningEfforts?: string[];
        }[];
        return new Map(list.map((m) => [m.id, m.supportedReasoningEfforts ?? []]));
      } catch {
        return undefined;
      }
    })();
    return this.models;
  }

  async runAgent(req: AgentRequest): Promise<AgentResponse> {
    const { pause } = req;
    const integrating = req.integrate !== undefined;
    const isolated = pause.isolated || integrating;
    const useMcp = pause.capabilities.includes('mcp') && !isolated;
    const mcpServers = useMcp ? (this.opts.mcpServers ?? {}) : {};
    const prompt = integrating
      ? buildIntegrationPrompt(pause, req.integrate!)
      : buildAgentPrompt(pause, {
          mcpServers: Object.keys(mcpServers),
          ...(req.scratchDir ? { scratchDir: req.scratchDir } : {}),
        });
    const startedAt = this.opts.clock?.();
    const tier = pause.otherModel
      ? await this.otherFamily(pause.complexity)
      : await this.modelFor(pause.complexity);
    if (tier.note) req.onEvent({ type: 'info', text: tier.note });
    req.onEvent({
      type: 'info',
      text: `${integrating ? 'integrating takes' : req.take ? `take ${req.take}` : 'playing'} · tier ${pause.complexity} · ${tier.model ?? 'default model'}${tier.effort ? ` (${tier.effort})` : ''}`,
    });
    // The last VALID answer wins (the AI may revise on purpose); an invalid one never
    // replaces it, even from a parallel call, and is kept only so the engine can say why.
    let valid: unknown;
    let invalid: unknown;
    const submitted = () => valid ?? invalid;
    let corrections = 0;
    const tool = defineTool(SUBMIT_TOOL, {
      description: `Submit the result of step '${pause.label}'. Call exactly once when done.`,
      parameters: resultJsonSchema(pause.outputSchema, pause.choices),
      skipPermission: true,
      handler: async (raw: unknown) => {
        const args = normalizeSubmission(raw);
        // Catch a malformed answer while the AI still has its context, instead of
        // a fresh attempt that redoes all the reading. The engine re-checks anyway.
        const checked = checkAgentResult(args, pause.outputSchema, pause.choices);
        const errors = checked.ok
          ? [
              ...(await this.citationErrors(pause, checked.value.updates)),
              // The step's own checks too ("at least 3 hypotheses"), on the state it would produce.
              ...checkErrors(acceptance(pause.checks ?? [], req.state, checked.value)),
            ]
          : checked.errors;
        if (errors.length === 0) {
          // Last valid wins, except that an empty answer never replaces one with content:
          // a skeptic's 8 real defects were lost to an empty second call that way.
          if (valid !== undefined && hasContent(valid) && !hasContent(args)) {
            req.onEvent({
              type: 'info',
              text: 'kept the earlier answer: the later valid one was empty and would have discarded its content',
            });
            return 'Not recorded: this result is empty, and your earlier result with content is kept. If that earlier result was wrong, submit the corrected content instead. Your step is complete: stop now.';
          }
          valid = args;
          return 'Result recorded. Your step is complete: stop now.';
        }
        invalid = args;
        if (corrections >= MAX_SUBMIT_CORRECTIONS) {
          return valid === undefined
            ? 'Result recorded. Your step is complete: stop now.'
            : 'Not recorded: your earlier valid result is kept. Your step is complete: stop now.';
        }
        corrections += 1;
        req.onEvent({
          type: 'info',
          text: `submit_result rejected (${corrections}/${MAX_SUBMIT_CORRECTIONS}), asking for a corrected call: ${errors.join('; ')}`,
        });
        return [
          'REJECTED: the result was not recorded.',
          ...errors.map((e) => `- ${e}`),
          `Call ${SUBMIT_TOOL} again now with the complete corrected result ({ updates, verdict${pause.choices ? ', next' : ''} }). Do not redo your research.`,
        ].join('\n');
      },
    });
    const tools = [
      tool,
      ...(pause.capabilities.includes('web') && !integrating
        ? [this.webSearchTool(req.signal)]
        : []),
    ];
    const play = (m: { model?: string; effort?: ReasoningEffort }) =>
      this.runSession({
        prompt,
        role: pause.role,
        tools,
        mcpServers,
        onlyCustomTools: isolated,
        ...(m.model ? { model: m.model } : {}),
        ...(m.effort ? { effort: m.effort } : {}),
        complexity: pause.complexity,
        signal: req.signal,
        onEvent: req.onEvent,
      });
    let out = await play(tier);
    let played: { model?: string } = tier;
    let usage = out.usage;
    const blockedOn: string[] = [];
    // A content filter blocks the same prompt on the same model every time, so the
    // engine's retries cannot help: let another model (the nearest tiers') answer.
    if (submitted() === undefined && isProviderBlock(out.output)) {
      for (const alt of await this.otherModels(pause.complexity, tier.model)) {
        blockedOn.push(out.model ?? played.model ?? 'default model');
        req.onEvent({
          type: 'info',
          text: `${blockedOn.at(-1)} blocked the response (content filtering); trying ${alt.model}`,
        });
        out = await play(alt);
        played = alt;
        usage = usage && out.usage ? addUsage(usage, out.usage) : (out.usage ?? usage);
        if (submitted() !== undefined || !isProviderBlock(out.output)) break;
      }
    }
    const model = out.model ?? played.model;
    return {
      result: submitted() ?? extractJson(out.output),
      transcript: {
        provider: this.name,
        ...(model ? { model } : {}),
        prompt,
        output: out.output,
        toolCalls: out.toolCalls,
        ...(usage ? { usage } : {}),
        ...(startedAt ? { startedAt, completedAt: this.opts.clock!() } : {}),
        musician: {
          tier: pause.complexity,
          ...(tier.model ? { requestedModel: tier.model } : {}),
          ...(tier.effort ? { effort: tier.effort } : {}),
          ...(blockedOn.length ? { blockedOn } : {}),
          account: this.usingSignedInUser ? 'signed-in user' : 'token',
          ...(SDK ? { sdk: SDK } : {}),
          sampling: SAMPLING_NOTE,
        },
      },
    };
  }

  async draft(req: DraftRequest): Promise<AgentResponse> {
    const prompt = [
      req.instructions,
      '',
      '## Request',
      req.request,
      ...(req.priorDraft
        ? ['', '## Previous draft', '```json', JSON.stringify(req.priorDraft, null, 2), '```']
        : []),
      ...(req.feedback?.length
        ? ['', '## Problems to fix', ...req.feedback.map((f) => `- ${f}`)]
        : []),
      '',
      `Call the \`${DRAFT_TOOL}\` tool once with { pattern: <the JSON object> }.`,
    ].join('\n');
    let submitted: unknown;
    const tool = defineTool(DRAFT_TOOL, {
      description: 'Submit the drafted workflow pattern as JSON.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'object', description: 'The pattern JSON object' } },
        required: ['pattern'],
      },
      skipPermission: true,
      handler: (args: unknown) => {
        submitted = (args as { pattern?: unknown } | undefined)?.pattern;
        return 'Draft recorded. Stop now.';
      },
    });
    const out = await this.runSession({
      prompt,
      role: 'assessor',
      tools: [tool],
      onlyCustomTools: true,
      signal: req.signal,
      onEvent: req.onEvent,
    });
    return {
      result: submitted ?? extractJson(out.output),
      transcript: {
        provider: this.name,
        prompt,
        output: out.output,
        toolCalls: out.toolCalls,
        ...(out.usage ? { usage: out.usage } : {}),
      },
    };
  }

  private webSearchTool(signal: AbortSignal): ReturnType<typeof defineTool> {
    const search =
      this.opts.webSearch ?? ((q: string, s: AbortSignal) => webSearch(q, { signal: s }));
    return defineTool(WEB_SEARCH_TOOL, {
      description:
        'Search the public web. Returns titles, URLs and snippets; read pages with web_fetch.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search terms' } },
        required: ['query'],
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const query = String((args as { query?: unknown } | undefined)?.query ?? '').trim();
        if (!query) return 'query is required';
        try {
          const results = await search(query, signal);
          return results.length
            ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')
            : 'No results.';
        } catch (e) {
          return `web_search failed: ${(e as Error).message}`;
        }
      },
    });
  }

  /**
   * Copilot refused the credential. A configured token is dropped once for the
   * signed-in account (the step runs again); if that is refused too, stop and say why.
   */
  private async refused(
    run: SessionRun,
    output: string,
  ): Promise<{ output: string; toolCalls: ToolCallRecord[]; model?: string; usage?: TokenUsage }> {
    if (this.opts.gitHubToken && !this.tokenRejected) {
      this.tokenRejected = true;
      this.signInChecked = false;
      run.onEvent({
        type: 'info',
        text: `Copilot refused the token in ${this.opts.gitHubTokenSource ?? 'your settings'} ("${output.slice(0, 120)}"); using the GitHub account signed in on this machine instead. Remove that token, or replace it with a fine-grained one with the "Copilot Requests" permission.`,
      });
      await this.dropClient();
      return this.runSession(run);
    }
    const login = await this.authStatus().then(
      (s) => s.login,
      () => undefined,
    );
    throw new SetupError(refusedHelp(login));
  }

  private async dropClient(): Promise<void> {
    const client = this.client;
    this.models = undefined;
    this.client = undefined;
    this.starting = undefined;
    await client?.stop().catch(() => {});
  }

  /** True once the configured token was rejected and the signed-in user is in use. */
  get usingSignedInUser(): boolean {
    return this.tokenRejected || !this.opts.gitHubToken;
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    await client?.stop().catch(() => {});
  }
}
