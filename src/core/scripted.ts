/**
 * Scripted (offline) answers for pauses. Pure and synchronous.
 * Used by the scripted provider, tests and the "demo" mode, so anyone can
 * run every flow without AI credentials. Nodes without a script get a
 * placeholder that satisfies the output schema.
 */
import {
  advance,
  createEngine,
  mapToolOutput,
  type AdvanceResult,
  type EngineState,
} from './engine.js';
import { zeroValue } from './schema.js';
import type { DemoScript, ExecutableScore, NodeResult, Pause, Resolution } from './types.js';

export function placeholderResult(pause: Extract<Pause, { kind: 'agent' }>): NodeResult {
  return {
    updates: Object.fromEntries(pause.outputSchema.map((f) => [f.name, zeroValue(f.type)])),
    verdict: {
      outcome: 'applied',
      confidence: 0.5,
      shouldTerminate: false,
      reason: `scripted placeholder for '${pause.label}'`,
    },
  };
}

export function scriptedResolution(
  demo: DemoScript | undefined,
  pause: Pause,
  engine: EngineState,
  at?: string,
): Resolution {
  const visit = (engine.visits[pause.nodeId] ?? 1) - 1;
  if (pause.kind === 'tool') {
    const raw = demo?.tools?.[pause.nodeId]?.(engine.state);
    return {
      kind: 'tool',
      pauseId: pause.pauseId,
      updates: raw
        ? mapToolOutput(pause.output, raw)
        : Object.fromEntries(pause.outputSchema.map((f) => [f.name, zeroValue(f.type)])),
      ...(at ? { at } : {}),
    };
  }
  if (pause.kind === 'agent') {
    const responder = demo?.agents?.[pause.nodeId];
    const result = responder ? responder(engine.state, visit) : placeholderResult(pause);
    return {
      kind: 'agent',
      pauseId: pause.pauseId,
      result,
      transcript: {
        provider: 'scripted',
        prompt: pause.directive,
        output: JSON.stringify(result),
        toolCalls: [],
        ...(at ? { startedAt: at, completedAt: at } : {}),
      },
      ...(at ? { at } : {}),
    };
  }
  const answer = demo?.approvals?.[pause.nodeId]?.(engine.state, visit) ?? {
    approved: true,
    updates: Object.fromEntries(pause.outputSchema.map((f) => [f.name, zeroValue(f.type)])),
  };
  return {
    kind: 'approval',
    pauseId: pause.pauseId,
    approved: answer.approved,
    ...(answer.updates ? { updates: answer.updates } : {}),
    by: 'scripted',
    ...(at ? { at } : {}),
  };
}

/** Run a score to completion with scripted answers. */
export function runScripted(
  score: ExecutableScore,
  demo: DemoScript | undefined,
  opts: { readonly at?: string; readonly maxIterations?: number } = {},
): AdvanceResult {
  let r = createEngine(score, opts.at ? { startedAt: opts.at } : {});
  const limit = opts.maxIterations ?? score.maxSteps * 4;
  for (let i = 0; i < limit && r.state.kind === 'running' && r.state.pause; i += 1) {
    r = advance(score, r.state, scriptedResolution(demo, r.state.pause, r.state, opts.at));
  }
  return r;
}
