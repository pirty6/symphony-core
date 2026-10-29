/**
 * Offline provider. Answers from a pattern's demo script (or schema-valid
 * placeholders) and streams the answer in small chunks so the studio shows
 * live output exactly like a real model would. Deterministic.
 */
import { genericDraft } from '../core/draft.js';
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
    const played: NodeResult = req.integrate
      ? (req.integrate[0] as NodeResult)
      : responder
        ? responder(req.state, req.visit)
        : placeholderResult(pause);
    // At an active solo with no scripted choice, play the written route (first edge).
    const result: NodeResult =
      pause.choices && !played.next ? { ...played, next: pause.choices[0]!.edgeId } : played;
    const prompt = buildAgentPrompt(pause);
    req.onEvent({
      type: 'info',
      text: req.integrate
        ? `scripted bandleader merging ${req.integrate.length} takes of '${pause.label}'`
        : `scripted ${pause.role} ${req.take ? `take ${req.take} of` : 'answering'} '${pause.label}' · tier ${pause.complexity}`,
    });
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
