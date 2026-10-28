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
  /** Full run state and visit index; only scripted/replay providers may use these. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly visit: number;
  readonly signal: AbortSignal;
  readonly onEvent: (e: ProviderEvent) => void;
  /** Jazz: which independent take this is (1-based) when the node plays several. */
  readonly take?: number;
  /** Jazz: the takes' results to merge; the call is then an isolated integration. */
  readonly integrate?: readonly unknown[];
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

export interface PromptSources {
  /** MCP servers connected for this node. */
  readonly mcpServers?: readonly string[];
}

export function buildAgentPrompt(pause: AgentPause, sources: PromptSources = {}): string {
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
    '## Sources you can use',
    pause.isolated
      ? '- Only the input above. You have no workspace or shell tools for this step: reason from what you were given.'
      : pause.role === 'assessor'
        ? '- Workspace: view, grep, glob and read-only shell commands (git log/show/blame/diff, gh issue/pr/run/search view|list, gh api GETs, ls, cat, find).'
        : '- Workspace: read, edit and run commands as this step needs.',
    ...(pause.capabilities.includes('web')
      ? [
          '- Web: web_search(query) to find pages, then web_fetch(url) to read them. Cite every URL you rely on.',
        ]
      : []),
    ...(pause.capabilities.includes('mcp')
      ? [
          sources.mcpServers?.length
            ? `- MCP servers: ${sources.mcpServers.join(', ')}${pause.role === 'assessor' ? ' (read-only tools only)' : ''}.`
            : '- MCP: no MCP servers are configured; say so instead of guessing.',
        ]
      : []),
    '',
    '## Rules',
    pause.role === 'assessor'
      ? '- You are READ-ONLY: read files and run read-only commands only. Edits and writes will be denied.'
      : '- You may edit files and run commands needed for THIS step only.',
    pause.choices
      ? `- When finished, call the \`${SUBMIT_TOOL}\` tool exactly once with { updates, verdict, next }, then stop.`
      : `- When finished, call the \`${SUBMIT_TOOL}\` tool exactly once with { updates, verdict }, then stop.`,
    '- `updates` must contain exactly these keys:',
    ...pause.outputSchema.map(
      (f) => `  - ${f.name} (${f.type})${f.description ? `: ${f.description}` : ''}`,
    ),
    '- `verdict`: { outcome: "applied" | "failed" | "skipped", confidence: 0..1, shouldTerminate: boolean, reason: one sentence }.',
    '- `shouldTerminate` is almost always false: the workflow moves on to its next step by itself. Set it to true ONLY to abort the entire workflow because continuing would be impossible or harmful.',
  );
  if (pause.outputSchema.length === 0)
    lines.push('- This step writes no state: send `updates: {}`.');
  if (pause.choices) {
    lines.push(
      '',
      '## Solo: you choose where the tune goes next',
      'Set `next` to exactly one of these route ids, based on what you found:',
      ...pause.choices.map((c) => `- \`${c.edgeId}\`: ${c.label}`),
    );
  }
  if (pause.improvisation >= 4) {
    lines.push(
      '',
      '## Free improvisation',
      'Unconventional angles are welcome: question the framing, try an approach others would not, and say what you tried.',
    );
  }
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
  readonly serverName?: string;
  readonly readOnly?: boolean;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

// Commands with no side effects. Anything not listed is treated as a write.
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'gh',
  'sed',
  'cd',
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'echo',
  'printf',
  'cut',
  'tr',
  'tree',
  'stat',
  'file',
  'which',
  'basename',
  'dirname',
  'realpath',
  'du',
  'df',
  'date',
  'true',
  'nl',
  'diff',
  'cmp',
  'comm',
  'jq',
  'sort',
  'find',
  'git',
  'test',
  '[',
  'read',
]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  'diff',
  'log',
  'show',
  'status',
  'blame',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'grep',
  'describe',
  'shortlog',
  'cat-file',
  'merge-base',
  'rev-list',
  'name-rev',
  'branch',
  'tag',
  'remote',
]);
/** git subcommands that only list when given no positional arguments. */
const LIST_ONLY_GIT: ReadonlySet<string> = new Set(['branch', 'tag', 'remote']);
const FIND_WRITES = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

function tokens(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
}

/** Split on unquoted `&&`, `||`, `;`, `|` and newlines. */
function splitCommands(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '|' || ch === '\n' || (ch === '&' && text[i + 1] === '&')) {
      out.push(cur);
      cur = '';
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i += 1;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const GH_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  issue: new Set(['view', 'list', 'status']),
  pr: new Set(['view', 'list', 'status', 'diff', 'checks']),
  run: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  repo: new Set(['view']),
  search: new Set(['issues', 'prs', 'code', 'commits', 'repos']),
  workflow: new Set(['view', 'list']),
};
const GH_API_WRITES = /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/;

/** gh: allowlisted view/list subcommands, and `gh api` only as a GET without a body. */
function ghIsReadOnly(args: readonly string[]): boolean {
  const [group, action] = args;
  if (group === 'api') {
    for (let i = 1; i < args.length; i += 1) {
      const a = args[i]!;
      if (GH_API_WRITES.test(a)) {
        const method = a.includes('=') ? a.split('=')[1] : args[i + 1];
        if ((a.startsWith('-X') || a.startsWith('--method')) && method?.toUpperCase() === 'GET')
          continue;
        return false;
      }
    }
    return true;
  }
  return Boolean(group && action && GH_READ[group]?.has(action));
}

/** Shell words that only shape control flow: the command after them is what runs. */
const LEADING_KEYWORDS: ReadonlySet<string> = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
]);
const CLOSING_KEYWORDS: ReadonlySet<string> = new Set(['done', 'fi', '}']);

/** Drop input redirections (`< file`, `<file`), which only read. */
function withoutInput(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '<') i += 1;
    else if (!(a.startsWith('<') && !a.startsWith('<<'))) out.push(a);
  }
  return out;
}

function segmentIsReadOnly(segment: string): boolean {
  // Subshell and group brackets around a command change nothing about what it does.
  let t = tokens(segment.replace(/^[(\s]+/, '').replace(/[)\s]+$/, ''));
  while (t[0] !== undefined && LEADING_KEYWORDS.has(t[0])) t = t.slice(1);
  // `done < file`, `fi`, `}`: closers, optionally reading input.
  if (t[0] !== undefined && CLOSING_KEYWORDS.has(t[0]))
    return withoutInput(t.slice(1)).length === 0;
  // `for NAME in WORDS`: the words are data, never run ($(…) is refused for the whole line).
  if (t[0] === 'for') return /^[A-Za-z_]\w*$/.test(t[1] ?? '') && (t.length === 2 || t[2] === 'in');
  const cmd = t[0];
  if (!cmd) return true;
  if (cmd.includes('=') || !READ_ONLY_COMMANDS.has(cmd)) return false;
  const args = t.slice(1);
  if (args.some((a) => a.startsWith('--output'))) return false;
  if (cmd === 'sort') return !args.some((a) => a === '-o' || a.startsWith('-o'));
  if (cmd === 'find') return !args.some((a) => FIND_WRITES.test(a));
  if (cmd === 'gh') return ghIsReadOnly(args);
  // sed only as a line printer: sed -n 'N,Mp' file (no -i, no w/e commands).
  if (cmd === 'sed')
    return args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1] ?? '') && args.length >= 2;
  if (cmd !== 'git') return true;
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const flag = args[i]!;
    if (flag === '-c' || flag.startsWith('--exec-path') || flag.startsWith('--config'))
      return false;
    i += flag === '-C' || flag === '--git-dir' || flag === '--work-tree' ? 2 : 1;
  }
  const sub = args[i];
  if (!sub || !READ_ONLY_GIT.has(sub)) return false;
  const rest = args.slice(i + 1);
  if (
    rest.some(
      (a) => a === '--ext-diff' || a === '-D' || a === '-d' || a === '-m' || a === '--delete',
    )
  )
    return false;
  if (LIST_ONLY_GIT.has(sub))
    return rest.every((a) => a.startsWith('-') || (sub === 'remote' && a === 'show'));
  return true;
}

/**
 * Conservative read-only check for a shell command line: every segment between
 * `&&`, `||`, `;` and `|` must be an allowlisted read-only command. Command
 * substitution, process substitution and output redirection are refused.
 */
export function isReadOnlyCommand(text: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(text)) return false;
  // Output may only go to another stream (2>&1) or nowhere (/dev/null); any other `>` writes a file.
  const unquoted = text
    .replace(/"[^"]*"|'[^']*'/g, '')
    .replace(/[0-9&]?>>?\s*\/dev\/null(?![\w/.-])/g, '')
    .replace(/[0-9]?>&[0-9]/g, '');
  if (unquoted.includes('>')) return false;
  return splitCommands(text).every((seg) => segmentIsReadOnly(seg.trim()));
}

/** Assessors may read; executors may do anything their step needs. */
export function decidePermission(role: Role, req: PermissionLike): PolicyDecision {
  if (role === 'executor') return { allowed: true, reason: 'executor is read-write' };
  switch (req.kind) {
    case 'read':
    case 'url':
    case 'custom-tool':
      return { allowed: true, reason: `${req.kind} is read-only` };
    case 'mcp':
      return req.readOnly === true
        ? {
            allowed: true,
            reason: `read-only MCP tool ${req.serverName ?? ''}/${req.toolName ?? ''}`,
          }
        : {
            allowed: false,
            reason: `assessor is read-only; MCP tool ${req.serverName ?? ''}/${req.toolName ?? ''} may have side effects`,
          };
    case 'shell': {
      const cmds = req.commands ?? [];
      const writes = cmds.filter((c) => !c.readOnly).map((c) => c.identifier);
      if (cmds.length > 0 && writes.length === 0 && !req.hasWriteFileRedirection) {
        return { allowed: true, reason: 'read-only command' };
      }
      if (
        !req.hasWriteFileRedirection &&
        req.fullCommandText &&
        isReadOnlyCommand(req.fullCommandText)
      ) {
        return { allowed: true, reason: 'read-only command (allowlist)' };
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

/** Prompt for merging independent takes of one step into a single answer (jazz). */
export function buildIntegrationPrompt(pause: AgentPause, takes: readonly unknown[]): string {
  return [
    `You are the bandleader integrating ${takes.length} independent takes of ONE workflow step.`,
    'Merge them into the single best answer for this step: keep every well-supported finding from any take,',
    'resolve conflicts in favour of the best-evidenced take and say so in the verdict reason, drop duplicates.',
    'You have no workspace tools: work only from the takes below.',
    '',
    '## Overall goal',
    pause.goal,
    '',
    `## The step: ${pause.label}`,
    pause.directive,
    '',
    '## Input the takes were given',
    '```json',
    JSON.stringify(pause.input, null, 2),
    '```',
    '',
    ...takes.flatMap((t, i) => [
      `## Take ${i + 1}`,
      '```json',
      JSON.stringify(t, null, 2),
      '```',
      '',
    ]),
    '## Rules',
    `- Call the \`${SUBMIT_TOOL}\` tool exactly once with { updates, verdict${pause.choices ? ', next' : ''} }, then stop.`,
    '- `updates` must contain exactly these keys:',
    ...pause.outputSchema.map(
      (f) => `  - ${f.name} (${f.type})${f.description ? `: ${f.description}` : ''}`,
    ),
    ...(pause.choices
      ? [
          '- `next`: one of ' +
            pause.choices.map((c) => `\`${c.edgeId}\` (${c.label})`).join(', ') +
            '.',
        ]
      : []),
    '- `verdict`: { outcome, confidence 0..1, shouldTerminate (almost always false), reason }.',
    ...(pause.feedback?.length
      ? ['', '## Previous answer was rejected', ...pause.feedback.map((f) => `- ${f}`)]
      : []),
  ].join('\n');
}
