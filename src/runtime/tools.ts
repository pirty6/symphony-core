/**
 * Deterministic tools that `tool` nodes run (no AI). Results are recorded in
 * the Performance, so replay feeds them back instead of re-running them.
 */
import type { ToolPause } from '../core/types.js';

export interface ToolContext {
  /** Folder the agents work in. */
  readonly workspace: string;
  /** Repository root of symphony-core (for saved runs). */
  readonly repoRoot: string;
  readonly signal: AbortSignal;
  /** The run calling the tool (memory caps what one run may add). */
  readonly runId?: string;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** Output keys the tool returns. */
  readonly outputs: readonly string[];
  run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolContext,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export type ToolRegistry = ReadonlyMap<string, ToolSpec>;

export function registry(tools: readonly ToolSpec[]): ToolRegistry {
  return new Map(tools.map((t) => [t.name, t]));
}

/** Check that a tool node's output mapping only uses keys the tool returns. */
export function checkToolPause(pause: ToolPause, tools: ToolRegistry): string | undefined {
  const spec = tools.get(pause.tool);
  if (!spec)
    return `unknown tool '${pause.tool}' (available: ${[...tools.keys()].join(', ') || 'none'})`;
  const unknown = Object.keys(pause.output).filter((k) => !spec.outputs.includes(k));
  return unknown.length > 0
    ? `tool '${pause.tool}' has no output(s) ${unknown.join(', ')} (it returns: ${spec.outputs.join(', ')})`
    : undefined;
}
