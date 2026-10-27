/**
 * Offline provider. Answers from a pattern's demo script (or schema-valid
 * placeholders) and streams the answer in small chunks so the studio shows
 * live output exactly like a real model would. Deterministic.
 */
import { placeholderResult } from '../core/scripted.js';
import type { DemoScript, NodeResult, Pattern } from '../core/types.js';
import type {
  AgentRequest,
  AgentResponse,
  DraftRequest,
  Provider,
  ProviderEvent,
} from './provider.js';
import { buildAgentPrompt, SUBMIT_TOOL } from './provider.js';

export interface ScriptedOptions {
  readonly demo?: DemoScript;
  /** Delay between streamed chunks; 0 for tests. */
  readonly delayMs?: number;
  readonly chunkSize?: number;
  readonly clock?: () => string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function stream(
  text: string,
  opts: ScriptedOptions,
  signal: AbortSignal,
  emit: (e: ProviderEvent) => void,
) {
  const size = opts.chunkSize ?? 12;
  for (let i = 0; i < text.length; i += size) {
    if (opts.delayMs) await sleep(opts.delayMs, signal);
    else if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    emit({ type: 'delta', text: text.slice(i, i + size) });
  }
  emit({ type: 'message', text });
}

export function genericDraft(request: string): Record<string, unknown> {
  const words = request.toLowerCase().match(/[a-z0-9]+/g) ?? ['task'];
  const name = words.slice(0, 4).join('-') || 'task';
  return {
    name,
    description: `Drafted flow: ${request.trim().slice(0, 120)}`,
    verbTriggers: words.slice(0, 2),
    requiredContext: ['request'],
    state: [
      { name: 'request', type: 'string', description: 'What the user asked for' },
      { name: 'analysis', type: 'string' },
      { name: 'plan', type: 'string' },
      { name: 'result', type: 'string' },
      { name: 'ok', type: 'boolean' },
      { name: 'attempts', type: 'number' },
    ],
    start: 'start',
    nodes: [
      { id: 'start', kind: 'start', label: 'Start' },
      {
        id: 'analyze',
        kind: 'agent',
        role: 'assessor',
        label: 'Analyze',
        directive:
          'Understand `request` by reading the workspace. Write an analysis and a numbered plan.',
        reads: ['request'],
        writes: ['analysis', 'plan'],
      },
      {
        id: 'approve',
        kind: 'approval',
        label: 'Approve plan',
        message: 'Approve the plan?',
        writes: [],
      },
      {
        id: 'execute',
        kind: 'agent',
        role: 'executor',
        label: 'Execute',
        directive:
          'Carry out `plan`. Report what you did in `result` and whether it worked in `ok`.',
        reads: ['request', 'plan', 'result'],
        writes: ['result', 'ok'],
        maxVisits: 3,
      },
      {
        id: 'count',
        kind: 'compute',
        label: 'Count attempt',
        assign: [{ field: 'attempts', expr: 'attempts + 1' }],
      },
      { id: 'worked', kind: 'condition', label: 'Worked?', expression: 'ok' },
      { id: 'retry', kind: 'condition', label: 'Retry?', expression: 'attempts < 3' },
      { id: 'done', kind: 'end', label: 'Done', outcome: 'success' },
      { id: 'failed', kind: 'end', label: 'Failed', outcome: 'failed' },
      { id: 'stopped', kind: 'end', label: 'Plan rejected', outcome: 'partial' },
    ],
    edges: [
      { id: 'start-analyze', from: 'start', to: 'analyze' },
      { id: 'analyze-approve', from: 'analyze', to: 'approve' },
      { id: 'approve-execute', from: 'approve', to: 'execute', branch: 'approved' },
      { id: 'approve-stopped', from: 'approve', to: 'stopped', branch: 'rejected' },
      { id: 'execute-count', from: 'execute', to: 'count' },
      { id: 'count-worked', from: 'count', to: 'worked' },
      { id: 'worked-done', from: 'worked', to: 'done', branch: 'then' },
      { id: 'worked-retry', from: 'worked', to: 'retry', branch: 'else' },
      { id: 'retry-execute', from: 'retry', to: 'execute', branch: 'then' },
      { id: 'retry-failed', from: 'retry', to: 'failed', branch: 'else' },
    ],
  };
}

export class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private readonly opts: ScriptedOptions;

  constructor(opts: ScriptedOptions = {}) {
    this.opts = opts;
  }

  static forPattern(pattern: Pattern, opts: Omit<ScriptedOptions, 'demo'> = {}): ScriptedProvider {
    return new ScriptedProvider({ ...opts, ...(pattern.demo ? { demo: pattern.demo } : {}) });
  }

  async runAgent(req: AgentRequest): Promise<AgentResponse> {
    const { pause } = req;
    const startedAt = this.opts.clock?.();
    const responder = this.opts.demo?.agents?.[pause.nodeId];
    const result: NodeResult = responder
      ? responder(req.state, req.visit)
      : placeholderResult(pause);
    const prompt = buildAgentPrompt(pause);
    req.onEvent({ type: 'info', text: `scripted ${pause.role} answering '${pause.label}'` });
    const thinking = `Working on "${pause.label}" (${pause.role}).\n${result.verdict.reason}.\n`;
    await stream(thinking, this.opts, req.signal, req.onEvent);
    const id = `scripted-${pause.pauseId}`;
    req.onEvent({ type: 'tool-start', id, name: SUBMIT_TOOL, args: result });
    req.onEvent({ type: 'tool-end', id, name: SUBMIT_TOOL, ok: true });
    return {
      result,
      transcript: {
        provider: this.name,
        prompt,
        output: thinking,
        toolCalls: [{ name: SUBMIT_TOOL, args: result, ok: true }],
        ...(startedAt ? { startedAt, completedAt: this.opts.clock!() } : {}),
      },
    };
  }

  async draft(req: DraftRequest): Promise<AgentResponse> {
    const draft = genericDraft(req.request);
    const text = `Drafting a flow for: ${req.request}\nanalyze -> approve -> execute -> verify (bounded retries)\n`;
    await stream(text, this.opts, req.signal, req.onEvent);
    return {
      result: draft,
      transcript: { provider: this.name, prompt: req.request, output: text, toolCalls: [] },
    };
  }
}
