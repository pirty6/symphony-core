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
import type { SessionConfig } from '@github/copilot-sdk';
import { resultJsonSchema } from '../core/schema.js';
import type { Role, ToolCallRecord } from '../core/types.js';
import type {
  AgentRequest,
  AgentResponse,
  DraftRequest,
  Provider,
  ProviderEvent,
} from './provider.js';
import { buildAgentPrompt, decidePermission, extractJson, SUBMIT_TOOL } from './provider.js';

export const DRAFT_TOOL = 'submit_draft';

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

export interface CopilotProviderOptions {
  readonly model?: string;
  readonly workingDirectory?: string;
  readonly gitHubToken?: string;
  /** Per-node timeout. Default 10 minutes. */
  readonly timeoutMs?: number;
  readonly clientFactory?: () => ClientLike;
  readonly clock?: () => string;
}

interface SessionRun {
  readonly prompt: string;
  readonly role: Role;
  readonly tool: ReturnType<typeof defineTool>;
  readonly onlyCustomTools: boolean;
  readonly signal: AbortSignal;
  readonly onEvent: (e: ProviderEvent) => void;
}

const abortError = () => new DOMException('aborted', 'AbortError');

export class CopilotProvider implements Provider {
  readonly name = 'copilot';
  private readonly opts: CopilotProviderOptions;
  private client: ClientLike | undefined;
  private starting: Promise<ClientLike> | undefined;

  constructor(opts: CopilotProviderOptions = {}) {
    this.opts = opts;
  }

  private ensureClient(): Promise<ClientLike> {
    if (this.client) return Promise.resolve(this.client);
    this.starting ??= (async () => {
      const client =
        this.opts.clientFactory?.() ??
        (new CopilotClient(
          this.opts.gitHubToken ? { gitHubToken: this.opts.gitHubToken } : {},
        ) as unknown as ClientLike);
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
    const toolCalls: ToolCallRecord[] = [];
    const config: SessionConfig = {
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.workingDirectory ? { workingDirectory: this.opts.workingDirectory } : {}),
      tools: [run.tool],
      ...(run.onlyCustomTools
        ? { availableTools: new ToolSet().addCustom(run.tool.name) }
        : { excludedTools: ['task'] }),
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
      throw new Error(
        `${msg}. ${
          this.opts.gitHubToken
            ? 'The configured token was rejected: fix or remove GITHUB_TOKEN / TOKEN in .env to use your signed-in GitHub user.'
            : 'Sign in with the Copilot CLI or `gh auth login`, or set GITHUB_TOKEN in .env.'
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

  async runAgent(req: AgentRequest): Promise<AgentResponse> {
    const { pause } = req;
    const prompt = buildAgentPrompt(pause);
    const startedAt = this.opts.clock?.();
    let submitted: unknown;
    const tool = defineTool(SUBMIT_TOOL, {
      description: `Submit the result of step '${pause.label}'. Call exactly once when done.`,
      parameters: resultJsonSchema(pause.outputSchema),
      skipPermission: true,
      handler: (args: unknown) => {
        submitted = args;
        return 'Result recorded. Your step is complete: stop now.';
      },
    });
    const out = await this.runSession({
      prompt,
      role: pause.role,
      tool,
      onlyCustomTools: false,
      signal: req.signal,
      onEvent: req.onEvent,
    });
    return {
      result: submitted ?? extractJson(out.output),
      transcript: {
        provider: this.name,
        ...(out.model || this.opts.model ? { model: out.model ?? this.opts.model } : {}),
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
      tool,
      onlyCustomTools: true,
      signal: req.signal,
      onEvent: req.onEvent,
    });
    return {
      result: submitted ?? extractJson(out.output),
      transcript: { provider: this.name, prompt, output: out.output, toolCalls: out.toolCalls },
    };
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    await client?.stop().catch(() => {});
  }
}
