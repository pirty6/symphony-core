/**
 * Copilot SDK provider: one fresh session per agent node.
 *
 *   - structured output through a `submit_result` tool whose JSON schema is
 *     derived from the node's `writes` (the engine still re-validates)
 *   - assessors are kept read-only by the permission handler
 *   - deltas, reasoning, tool calls and permission decisions stream to the UI
 *   - AbortSignal aborts the live session (stop mid-node)
 */
import { CopilotClient, defineTool, ToolSet } from '@github/copilot-sdk';
import type { MCPServerConfig, SessionConfig } from '@github/copilot-sdk';
import { webSearch, type SearchResult } from './web-search.js';
import { resultJsonSchema } from '../core/schema.js';
import type { Complexity, Role, ToolCallRecord } from '../core/types.js';
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
  readonly workingDirectory?: string;
  /** MCP servers connected to nodes with the 'mcp' capability. */
  readonly mcpServers?: Readonly<Record<string, MCPServerConfig>>;
  /** Backend for the web_search tool (nodes with the 'web' capability). */
  readonly webSearch?: (query: string, signal: AbortSignal) => Promise<readonly SearchResult[]>;
  readonly gitHubToken?: string;
  /** Per-node timeout. Default 10 minutes. */
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
  readonly signal: AbortSignal;
  readonly onEvent: (e: ProviderEvent) => void;
}

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
        (new CopilotClient(token ? auth : { useLoggedInUser: true }) as unknown as ClientLike);
      await client.start();
      this.client = client;
      return client;
    })();
    return this.starting;
  }

  private async runSession(
    run: SessionRun,
  ): Promise<{ output: string; toolCalls: ToolCallRecord[]; model?: string }> {
    if (run.signal.aborted) throw abortError();
    const client = await this.ensureClient();
    if (run.signal.aborted) throw abortError();
    const toolCalls: ToolCallRecord[] = [];
    const config: SessionConfig = {
      ...(run.model ? { model: run.model } : {}),
      ...(run.effort ? { reasoningEffort: run.effort } : {}),
      ...(this.opts.workingDirectory ? { workingDirectory: this.opts.workingDirectory } : {}),
      tools: [...run.tools],
      ...(run.onlyCustomTools
        ? { availableTools: run.tools.reduce((set, t) => set.addCustom(t.name), new ToolSet()) }
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
        return this.runSession(run);
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
    const timeoutMs = this.opts.timeoutMs ?? 10 * 60_000;
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
    return { output, toolCalls, ...(model ? { model } : {}) };
  }

  /** Resolve the model and reasoning effort for a tier, checked against the models available. */
  async modelFor(
    complexity: Complexity,
  ): Promise<{ model?: string; effort?: ReasoningEffort; note?: string }> {
    if (this.opts.model) return { model: this.opts.model };
    const tier = { ...DEFAULT_TIERS, ...this.opts.tiers }[complexity];
    const available = await this.availableModels();
    if (available && !available.has(tier.model)) {
      return {
        note: `tier ${complexity} model '${tier.model}' is not available to you; using the default model`,
      };
    }
    const efforts = available?.get(tier.model);
    const effort =
      tier.effort && (!efforts || efforts.includes(tier.effort)) ? tier.effort : undefined;
    return { model: tier.model, ...(effort ? { effort } : {}) };
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
      : buildAgentPrompt(pause, { mcpServers: Object.keys(mcpServers) });
    const startedAt = this.opts.clock?.();
    const tier = await this.modelFor(pause.complexity);
    if (tier.note) req.onEvent({ type: 'info', text: tier.note });
    req.onEvent({
      type: 'info',
      text: `${integrating ? 'integrating takes' : req.take ? `take ${req.take}` : 'playing'} · tier ${pause.complexity} · ${tier.model ?? 'default model'}${tier.effort ? ` (${tier.effort})` : ''}`,
    });
    let submitted: unknown;
    const tool = defineTool(SUBMIT_TOOL, {
      description: `Submit the result of step '${pause.label}'. Call exactly once when done.`,
      parameters: resultJsonSchema(pause.outputSchema, pause.choices),
      skipPermission: true,
      handler: (args: unknown) => {
        submitted = args;
        return 'Result recorded. Your step is complete: stop now.';
      },
    });
    const tools = [
      tool,
      ...(pause.capabilities.includes('web') && !integrating
        ? [this.webSearchTool(req.signal)]
        : []),
    ];
    const out = await this.runSession({
      prompt,
      role: pause.role,
      tools,
      mcpServers,
      onlyCustomTools: isolated,
      ...(tier.model ? { model: tier.model } : {}),
      ...(tier.effort ? { effort: tier.effort } : {}),
      signal: req.signal,
      onEvent: req.onEvent,
    });
    const model = out.model ?? tier.model;
    return {
      result: submitted ?? extractJson(out.output),
      transcript: {
        provider: this.name,
        ...(model ? { model } : {}),
        prompt,
        output: out.output,
        toolCalls: out.toolCalls,
        ...(startedAt ? { startedAt, completedAt: this.opts.clock!() } : {}),
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
      transcript: { provider: this.name, prompt, output: out.output, toolCalls: out.toolCalls },
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
