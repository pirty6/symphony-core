/**
 * Provider contract: how the driver asks "something" (Copilot, a script,
 * a recording) to perform one agent node. Plus the pure pieces every
 * provider shares: the prompt, result extraction and the role policy.
 */
import type { AgentPause, AiTranscript, Role } from '../core/types.js';

export type ProviderEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'message'; readonly text: string }
  | {
      readonly type: 'tool-start';
      readonly id: string;
      readonly name: string;
      readonly args?: unknown;
    }
  | { readonly type: 'tool-end'; readonly id: string; readonly name: string; readonly ok: boolean }
  | {
      readonly type: 'permission';
      readonly kind: string;
      readonly allowed: boolean;
      readonly detail: string;
    }
  | { readonly type: 'info'; readonly text: string };

export interface AgentRequest {
  readonly pause: AgentPause;
  readonly signal: AbortSignal;
  readonly onEvent: (e: ProviderEvent) => void;
}

export interface AgentResponse {
  /** Raw, unvalidated result; the engine validates it. */
  readonly result: unknown;
  readonly transcript: AiTranscript;
}

export interface DraftRequest {
  readonly request: string;
  readonly instructions: string;
  readonly priorDraft?: unknown;
  readonly feedback?: readonly string[];
  readonly signal: AbortSignal;
  readonly onEvent: (e: ProviderEvent) => void;
}

export interface Provider {
  readonly name: string;
  runAgent(req: AgentRequest): Promise<AgentResponse>;
  draft(req: DraftRequest): Promise<AgentResponse>;
  dispose?(): Promise<void>;
}

export const SUBMIT_TOOL = 'submit_result';

export function buildAgentPrompt(pause: AgentPause): string {
  const lines: string[] = [
    `You are the ${pause.role.toUpperCase()} for ONE step of a deterministic workflow.`,
    'A state machine (not you) decides what runs next. Do only this step.',
    '',
    '## Overall goal',
    pause.goal,
    '',
    `## Your step: ${pause.label}`,
    pause.directive,
    '',
    '## Input (current workflow state you may use)',
    '```json',
    JSON.stringify(pause.input, null, 2),
    '```',
  ];
  if (Object.keys(pause.context).length > 0) {
    lines.push('', '## Context', '```json', JSON.stringify(pause.context, null, 2), '```');
  }
  lines.push(
    '',
    '## Rules',
    pause.role === 'assessor'
      ? '- You are READ-ONLY: read files and run read-only commands only. Edits and writes will be denied.'
      : '- You may edit files and run commands needed for THIS step only.',
    `- When finished, call the \`${SUBMIT_TOOL}\` tool exactly once with { updates, verdict }, then stop.`,
    '- `updates` must contain exactly these keys:',
    ...pause.outputSchema.map(
      (f) => `  - ${f.name} (${f.type})${f.description ? `: ${f.description}` : ''}`,
    ),
    '- `verdict`: { outcome: "applied" | "failed" | "skipped", confidence: 0..1, shouldTerminate: boolean, reason: one sentence }.',
    '- Use shouldTerminate=true only if the whole workflow must stop now.',
  );
  if (pause.outputSchema.length === 0)
    lines.push('- This step writes no state: send `updates: {}`.');
  if (pause.feedback && pause.feedback.length > 0) {
    lines.push(
      '',
      `## Your previous answer was rejected (attempt ${pause.attempt} of ${pause.maxAttempts})`,
      ...pause.feedback.map((f) => `- ${f}`),
      'Fix these problems in your next submission.',
    );
  }
  return lines.join('\n');
}

/** Fallback when no tool call was made: take the last JSON object in the text. */
export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = [...fenced.toReversed(), text];
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

// ── Role policy ────────────────────────────────────────────────────

export interface PermissionLike {
  readonly kind: string;
  readonly commands?: readonly { readonly identifier: string; readonly readOnly: boolean }[];
  readonly hasWriteFileRedirection?: boolean;
  readonly fullCommandText?: string;
  readonly fileName?: string;
  readonly toolName?: string;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** Assessors may read; executors may do anything their step needs. */
export function decidePermission(role: Role, req: PermissionLike): PolicyDecision {
  if (role === 'executor') return { allowed: true, reason: 'executor is read-write' };
  switch (req.kind) {
    case 'read':
    case 'url':
    case 'custom-tool':
      return { allowed: true, reason: `${req.kind} is read-only` };
    case 'shell': {
      const cmds = req.commands ?? [];
      const writes = cmds.filter((c) => !c.readOnly).map((c) => c.identifier);
      if (cmds.length > 0 && writes.length === 0 && !req.hasWriteFileRedirection) {
        return { allowed: true, reason: 'read-only command' };
      }
      return {
        allowed: false,
        reason: `assessor is read-only; refused: ${writes.join(', ') || req.fullCommandText || 'shell'}${req.hasWriteFileRedirection ? ' (file redirection)' : ''}`,
      };
    }
    default:
      return { allowed: false, reason: `assessor is read-only; '${req.kind}' is not allowed` };
  }
}
