/**
 * AI-drafted patterns: prompt, strict parsing, and TypeScript codegen.
 *
 * The AI only proposes JSON. `parseDraft` normalizes and validates it;
 * nothing runs until a human approves it, and an approved draft is
 * persisted as a TypeScript module via `patternToTypeScript`.
 */
import { isFieldType } from './schema.js';
import type { Checked } from './schema.js';
import { isImprovisation } from './jazz.js';
import type { Capability, Complexity, Pattern, ScoreEdge, ScoreNode, StateField } from './types.js';
import { validatePattern } from './validate.js';

const isComplexity = (v: unknown): v is Complexity => v === 1 || v === 2 || v === 3 || v === 4;
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

function parseNode(raw: unknown, i: number, errors: string[]): ScoreNode | undefined {
  if (!isObj(raw)) {
    errors.push(`nodes[${i}] must be an object`);
    return undefined;
  }
  const id = str(raw.id);
  const label = str(raw.label) ?? id;
  if (!id) {
    errors.push(`nodes[${i}].id is required`);
    return undefined;
  }
  const base = {
    id,
    label: label ?? id,
    ...(posInt(raw.maxVisits) ? { maxVisits: posInt(raw.maxVisits)! } : {}),
  };
  switch (raw.kind) {
    case 'start':
      return { ...base, kind: 'start' };
    case 'end': {
      const outcome = ['success', 'failed', 'partial'].includes(raw.outcome as string)
        ? (raw.outcome as 'success' | 'failed' | 'partial')
        : undefined;
      return { ...base, kind: 'end', ...(outcome ? { outcome } : {}) };
    }
    case 'agent': {
      const role =
        raw.role === 'executor' ? 'executor' : raw.role === 'assessor' ? 'assessor' : undefined;
      if (!role) errors.push(`nodes[${i}] (${id}) role must be assessor or executor`);
      const checks = Array.isArray(raw.checks)
        ? raw.checks
            .filter(isObj)
            .map((c) => ({ expr: str(c.expr) ?? '', message: str(c.message) ?? '' }))
        : [];
      const capabilities = strList(raw.capabilities) as Capability[];
      return {
        ...base,
        kind: 'agent',
        role: role ?? 'assessor',
        directive: str(raw.directive) ?? '',
        reads: strList(raw.reads),
        writes: strList(raw.writes),
        ...(typeof raw.retries === 'number' ? { retries: raw.retries } : {}),
        ...(checks.length > 0 ? { checks } : {}),
        ...(capabilities.length > 0 ? { capabilities } : {}),
        ...(isComplexity(raw.complexity) ? { complexity: raw.complexity } : {}),
        ...(raw.isolated === true ? { isolated: true } : {}),
        ...(raw.solo === true ? { solo: true } : {}),
      };
    }
    case 'compute': {
      const assign = Array.isArray(raw.assign)
        ? raw.assign
            .filter(isObj)
            .map((a) => ({ field: str(a.field) ?? '', expr: str(a.expr) ?? '' }))
        : [];
      return { ...base, kind: 'compute', assign };
    }
    case 'condition':
      return { ...base, kind: 'condition', expression: str(raw.expression) ?? '' };
    case 'tool': {
      const output = isObj(raw.output)
        ? Object.fromEntries(
            Object.entries(raw.output).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : {};
      return {
        ...base,
        kind: 'tool',
        tool: str(raw.tool) ?? '',
        ...(isObj(raw.args) ? { args: raw.args } : {}),
        ...(isObj(raw.inputs)
          ? {
              inputs: Object.fromEntries(
                Object.entries(raw.inputs).filter(
                  (e): e is [string, string] => typeof e[1] === 'string',
                ),
              ),
            }
          : {}),
        output,
      };
    }
    case 'approval':
      return {
        ...base,
        kind: 'approval',
        message: str(raw.message) ?? label ?? id,
        writes: strList(raw.writes),
        ...(strList(raw.shows).length ? { shows: strList(raw.shows) } : {}),
      };
    default:
      errors.push(`nodes[${i}] (${id}) has unknown kind '${String(raw.kind)}'`);
      return undefined;
  }
}

function parseEdge(raw: unknown, i: number, errors: string[]): ScoreEdge | undefined {
  if (!isObj(raw) || !str(raw.from) || !str(raw.to)) {
    errors.push(`edges[${i}] needs from and to`);
    return undefined;
  }
  const branch = ['then', 'else', 'approved', 'rejected'].includes(raw.branch as string)
    ? (raw.branch as ScoreEdge['branch'])
    : undefined;
  return {
    id: str(raw.id) ?? `${str(raw.from)}-${str(raw.to)}-${i}`,
    from: str(raw.from)!,
    to: str(raw.to)!,
    ...(str(raw.guard)?.trim() ? { guard: str(raw.guard)!.trim() } : {}),
    ...(branch ? { branch } : {}),
    ...(str(raw.label) ? { label: str(raw.label)! } : {}),
  };
}

export function parseDraft(raw: unknown): Checked<Pattern> {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['draft must be a JSON object'] };
  const state: StateField[] = [];
  (Array.isArray(raw.state) ? raw.state : []).forEach((f, i) => {
    if (!isObj(f) || !str(f.name) || !isFieldType(f.type)) {
      errors.push(
        `state[${i}] needs name and a type of string|number|boolean|string[]|number[]|object`,
      );
      return;
    }
    state.push({
      name: str(f.name)!,
      type: f.type,
      ...(str(f.description) ? { description: str(f.description)! } : {}),
      ...(f.initial !== undefined ? { initial: f.initial } : {}),
    });
  });
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .map((n, i) => parseNode(n, i, errors))
    .filter((n): n is ScoreNode => n !== undefined);
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .map((e, i) => parseEdge(e, i, errors))
    .filter((e): e is ScoreEdge => e !== undefined);
  const pattern: Pattern = {
    name: str(raw.name) ?? 'draft',
    description: str(raw.description) ?? '',
    verbTriggers: strList(raw.verbTriggers),
    requiredContext: strList(raw.requiredContext),
    ...(str(raw.goalFrom) ? { goalFrom: str(raw.goalFrom)! } : {}),
    ...(strList(raw.result).length > 0 ? { result: strList(raw.result) } : {}),
    state,
    nodes,
    edges,
    start: str(raw.start) ?? nodes.find((n) => n.kind === 'start')?.id ?? '',
    ...(posInt(raw.maxSteps) ? { maxSteps: posInt(raw.maxSteps)! } : {}),
    ...(isComplexity(raw.complexity) ? { complexity: raw.complexity } : {}),
    ...(isImprovisation(raw.improvisation) ? { improvisation: raw.improvisation } : {}),
    ...(Array.isArray(raw.groups) && raw.groups.length > 0
      ? {
          groups: raw.groups.filter(isObj).map((g) => {
            const group = {
              id: str(g.id) ?? '',
              label: str(g.label) ?? str(g.id) ?? '',
              nodes: strList(g.nodes),
            };
            const description = str(g.description);
            return description ? Object.assign(group, { description }) : group;
          }),
        }
      : {}),
  };
  errors.push(...validatePattern(pattern).errors.map((e) => e.message));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: pattern };
}

export function draftInstructions(): string {
  return `You design deterministic workflows ("patterns") for a state machine. Return ONE JSON object:
{ name: kebab-case, description, verbTriggers: string[], requiredContext: string[] (state keys the user must supply),
  goalFrom?: the requiredContext string key that states the goal (e.g. "question"; omit if none does),
  result?: string[] (state keys the run delivers, shown as its result),
  state: [{ name, type: string|number|boolean|string[]|number[]|object, description?, initial? }],
  nodes: [...], edges: [{ id, from, to, guard?, branch?, label? }], start: id of the start node, maxSteps? }

Node kinds:
- start {id,kind:"start",label}: exactly one.
- agent {id,kind:"agent",role:"assessor"|"executor",label,directive,reads:[state keys],writes:[state keys],maxVisits?,
  capabilities?:["web","mcp"], checks?:[{expr,message}], complexity?:1-4, isolated?:true (no workspace tools),
  solo?:true (assessor only: from Swing up the AI picks one of its labelled, unguarded out edges)} - checks are expressions over state+answer that must be true
  or the answer is rejected and re-asked (use them to force full coverage, e.g. subset(batch, examined)).
  assessor = read-only research/analysis; executor = may edit files and run commands. AI runs ONLY in agent nodes.
- compute {id,kind:"compute",label,assign:[{field,expr}]}: deterministic state update (counters, flags, appends).
- condition {id,kind:"condition",label,expression}: exactly two out edges with branch "then" and "else".
- approval {id,kind:"approval",label,message,writes:[keys a human provides],shows?:[keys to display]}: out edges branch "approved" (and optional "rejected").
- tool {id,kind:"tool",label,tool,args?,inputs?:{argName: stateKey},output:{toolKey: stateKey}}: deterministic I/O run by the system, not AI.
  Tools: "repo.files" -> {files, excluded} (every file in the workspace); "sources.catalog" -> {names, descriptions}
  (every evidence source available: git history, GitHub, dependencies, web, MCP servers, prior runs).
- end {id,kind:"end",label,outcome?:"success"|"failed"|"partial"}.
Optional "groups": [{id,label,description?,nodes:[node ids]}] name the phases of the flow (e.g. "List evidence",
"Deep read"); each phase is shown as one collapsible step. Approval nodes may list state keys to show in "shows".

Expressions (guards, conditions, compute): state keys by name, literals, == != < <= > >= && || ! + -,
functions len(x) empty(x) includes(list,v) lower(s) append(list,v) if(c,a,b) chars(s) subset(a,b),
and verdict.outcome / verdict.confidence of the last agent. Must be boolean for guards/conditions.

Rules: every node reachable from start; an end reachable from every node; edges are tried in order and
the unguarded default edge must be last; every loop needs a bound (maxVisits on a node in the loop or a
counter checked by a condition). Prefer compute/condition nodes over agents for anything mechanical.
Keep it small: 4-10 nodes.`;
}

// ── TypeScript codegen ─────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Single-quoted string literal; JSON escaping covers every control and line-separator character. */
function tsString(s: string): string {
  const body = JSON.stringify(s)
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/'/g, "\\'")
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${body}'`;
}

function tsLiteral(value: unknown, indent: string): string {
  const next = `${indent}  `;
  if (typeof value === 'string') return tsString(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => `${next}${tsLiteral(v, next)},`).join('\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(([k, v]) => `${next}${IDENT.test(k) ? k : tsString(k)}: ${tsLiteral(v, next)},`)
    .join('\n')}\n${indent}}`;
}

export function camelName(kebab: string): string {
  const c = kebab
    .replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())
    .replace(/[^A-Za-z0-9_]/g, '');
  return /^[A-Za-z_]/.test(c) ? c : `p${c}`;
}

export function patternToTypeScript(pattern: Pattern): string {
  const { demo: _demo, ...data } = pattern;
  return `import type { Pattern } from '../core/types.js';

/** ${pattern.description.replace(/\*\//g, '*\\/')} */
export const ${camelName(pattern.name)}: Pattern = ${tsLiteral(data, '')};
`;
}

/** A small, valid analyze -> approve -> execute -> verify draft (offline drafting and demos). */
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
