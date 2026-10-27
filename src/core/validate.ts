/**
 * Static validation of a pattern graph. Pure.
 * Issues carry nodeId / edgeId so the UI can highlight them on the canvas.
 */
import { ExprError, exprFields, parseExpr } from './expr.js';
import { checkValue, isFieldType, isValidFieldName } from './schema.js';
import {
  CAPABILITIES,
  type Pattern,
  type PatternGraph,
  type ScoreEdge,
  type ScoreNode,
} from './types.js';

export interface Issue {
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}

export interface ValidationReport {
  readonly errors: Issue[];
  readonly warnings: Issue[];
}

const ID = /^[A-Za-z0-9_-]+$/;
const ROLES: ReadonlySet<string> = new Set(['assessor', 'executor']);
const CAPS: ReadonlySet<string> = new Set(CAPABILITIES);

function checkExpr(
  src: string,
  known: ReadonlySet<string>,
  where: Omit<Issue, 'message'>,
  what: string,
  errors: Issue[],
): void {
  try {
    const unknown = exprFields(parseExpr(src)).filter((f) => !known.has(f));
    if (unknown.length > 0) {
      errors.push({
        ...where,
        message: `${what} references unknown field(s): ${unknown.join(', ')}`,
      });
    }
  } catch (e) {
    const msg = e instanceof ExprError ? e.message : String(e);
    errors.push({ ...where, message: `${what} '${src}' is invalid: ${msg}` });
  }
}

function checkOutEdges(
  node: ScoreNode,
  out: readonly ScoreEdge[],
  errors: Issue[],
  warnings: Issue[],
): void {
  const at = { nodeId: node.id };
  if (node.kind === 'end') {
    if (out.length > 0) errors.push({ ...at, message: 'end node cannot have outgoing edges' });
    return;
  }
  if (out.length === 0) {
    errors.push({ ...at, message: `${node.kind} node '${node.id}' has no outgoing edge` });
    return;
  }
  if (node.kind === 'agent' && node.solo) {
    if (out.length < 2)
      errors.push({ ...at, message: 'a solo node needs at least two outgoing routes' });
    for (const e of out) {
      if (e.guard || e.branch)
        errors.push({ edgeId: e.id, message: 'solo routes cannot have guards or branches' });
      if (!e.label?.trim())
        errors.push({ edgeId: e.id, message: 'solo routes need a label the AI can choose by' });
    }
    return;
  }
  if (node.kind === 'condition') {
    const branches = out.map((e) => e.branch).toSorted();
    if (out.length !== 2 || branches[0] !== 'else' || branches[1] !== 'then') {
      errors.push({
        ...at,
        message: "condition node needs exactly one 'then' and one 'else' edge",
      });
    }
    for (const e of out) {
      if (e.guard) errors.push({ edgeId: e.id, message: 'condition edges use branch, not guard' });
    }
    return;
  }
  for (const e of out) {
    if (e.branch === 'then' || e.branch === 'else') {
      errors.push({
        edgeId: e.id,
        message: `branch '${e.branch}' is only valid on condition nodes`,
      });
    }
    if ((e.branch === 'approved' || e.branch === 'rejected') && node.kind !== 'approval') {
      errors.push({
        edgeId: e.id,
        message: `branch '${e.branch}' is only valid on approval nodes`,
      });
    }
  }
  const groups =
    node.kind === 'approval'
      ? [out.filter((e) => e.branch !== 'rejected'), out.filter((e) => e.branch === 'rejected')]
      : [out];
  groups.forEach((group, gi) => {
    const defaults = group.filter((e) => !e.guard);
    if (defaults.length > 1) {
      errors.push({ ...at, message: 'at most one unguarded (default) edge per branch' });
    }
    const firstDefault = group.findIndex((e) => !e.guard);
    if (firstDefault !== -1 && firstDefault < group.length - 1) {
      errors.push({
        ...at,
        message: 'the unguarded (default) edge must be declared last; edges are tried in order',
      });
    }
    if (group.length > 0 && defaults.length === 0) {
      warnings.push({
        ...at,
        message: 'no default edge: the run fails if no guard matches',
      });
    }
    if (node.kind === 'approval' && gi === 0 && group.length === 0) {
      errors.push({ ...at, message: 'approval node needs an edge for the approved path' });
    }
  });
}

export function validateGraph(g: PatternGraph): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const fieldNames = new Set<string>();
  for (const f of g.state) {
    if (!isValidFieldName(f.name)) errors.push({ message: `invalid state field name '${f.name}'` });
    if (fieldNames.has(f.name)) errors.push({ message: `duplicate state field '${f.name}'` });
    fieldNames.add(f.name);
    if (!isFieldType(f.type)) {
      errors.push({ message: `state field '${f.name}' has invalid type '${String(f.type)}'` });
    } else if (f.initial !== undefined) {
      const err = checkValue(f.type, f.initial);
      if (err) errors.push({ message: `state field '${f.name}' initial value: ${err}` });
    }
  }
  const guardFields = new Set([...fieldNames, 'verdict']);

  const nodes = new Map<string, ScoreNode>();
  for (const n of g.nodes) {
    const at = { nodeId: n.id };
    if (!ID.test(n.id)) errors.push({ ...at, message: `invalid node id '${n.id}'` });
    if (nodes.has(n.id)) errors.push({ ...at, message: `duplicate node id '${n.id}'` });
    nodes.set(n.id, n);
    if (n.maxVisits !== undefined && (!Number.isInteger(n.maxVisits) || n.maxVisits < 1)) {
      errors.push({ ...at, message: 'maxVisits must be a positive integer' });
    }
    const unknownField = (keys: readonly string[], what: string) => {
      for (const k of keys) {
        if (!fieldNames.has(k))
          errors.push({ ...at, message: `${what} unknown state field '${k}'` });
      }
    };
    switch (n.kind) {
      case 'agent':
        if (!ROLES.has(n.role)) errors.push({ ...at, message: `invalid role '${n.role}'` });
        if (!n.directive?.trim()) errors.push({ ...at, message: 'agent node needs a directive' });
        unknownField(n.reads, 'reads');
        unknownField(n.writes, 'writes');
        if (n.retries !== undefined && (!Number.isInteger(n.retries) || n.retries < 0)) {
          errors.push({ ...at, message: 'retries must be a non-negative integer' });
        }
        for (const c of n.checks ?? []) {
          if (!c.message?.trim())
            errors.push({ ...at, message: `check '${c.expr}' needs a message` });
          checkExpr(c.expr, guardFields, at, 'check', errors);
        }
        if (n.complexity !== undefined && ![1, 2, 3, 4].includes(n.complexity)) {
          errors.push({ ...at, message: 'complexity must be 1, 2, 3 or 4' });
        }
        if (n.solo && n.role !== 'assessor') {
          errors.push({
            ...at,
            message: 'solo points must be assessors (they choose; executors act)',
          });
        }
        for (const cap of n.capabilities ?? []) {
          if (!CAPS.has(cap)) errors.push({ ...at, message: `unknown capability '${cap}'` });
        }
        break;
      case 'compute':
        if (n.assign.length === 0)
          errors.push({ ...at, message: 'compute node needs assignments' });
        for (const a of n.assign) {
          unknownField([a.field], 'assigns');
          checkExpr(a.expr, fieldNames, at, `assignment to '${a.field}'`, errors);
        }
        break;
      case 'condition':
        checkExpr(n.expression, guardFields, at, 'condition', errors);
        break;
      case 'approval':
        unknownField(n.writes, 'writes');
        break;
      case 'tool':
        if (!n.tool?.trim()) errors.push({ ...at, message: 'tool node needs a tool name' });
        if (!n.output || Object.keys(n.output).length === 0) {
          errors.push({ ...at, message: 'tool node needs an output mapping' });
        } else {
          unknownField(Object.values(n.output), 'output writes');
        }
        unknownField(Object.values(n.inputs ?? {}), 'inputs');
        break;
      case 'start':
      case 'end':
        break;
      default:
        errors.push({ ...at, message: `unknown node kind '${(n as { kind: string }).kind}'` });
    }
  }

  const starts = g.nodes.filter((n) => n.kind === 'start');
  if (starts.length !== 1)
    errors.push({ message: `need exactly one start node, found ${starts.length}` });
  if (!nodes.has(g.start) || nodes.get(g.start)?.kind !== 'start') {
    errors.push({ message: `start '${g.start}' must reference the start node` });
  }
  if (g.maxSteps !== undefined && (!Number.isInteger(g.maxSteps) || g.maxSteps < 1)) {
    errors.push({ message: 'maxSteps must be a positive integer' });
  }
  if (g.complexity !== undefined && ![1, 2, 3, 4].includes(g.complexity)) {
    errors.push({ message: 'complexity must be 1, 2, 3 or 4' });
  }
  if (g.improvisation !== undefined && ![0, 1, 2, 3, 4].includes(g.improvisation)) {
    errors.push({ message: 'improvisation must be 0..4' });
  }

  const edgeIds = new Set<string>();
  const outgoing = new Map<string, ScoreEdge[]>();
  for (const e of g.edges) {
    const at = { edgeId: e.id };
    if (edgeIds.has(e.id)) errors.push({ ...at, message: `duplicate edge id '${e.id}'` });
    edgeIds.add(e.id);
    if (!nodes.has(e.from)) errors.push({ ...at, message: `edge from unknown node '${e.from}'` });
    if (!nodes.has(e.to)) errors.push({ ...at, message: `edge to unknown node '${e.to}'` });
    if (nodes.get(e.to)?.kind === 'start')
      errors.push({ ...at, message: 'edges cannot enter the start node' });
    if (e.guard !== undefined) checkExpr(e.guard, guardFields, at, 'guard', errors);
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
  }
  for (const n of g.nodes) checkOutEdges(n, outgoing.get(n.id) ?? [], errors, warnings);

  // Reachability: forward from start, backward from ends.
  const reach = new Set<string>();
  const stack = nodes.has(g.start) ? [g.start] : [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reach.has(id)) continue;
    reach.add(id);
    for (const e of outgoing.get(id) ?? []) stack.push(e.to);
  }
  for (const n of g.nodes) {
    if (!reach.has(n.id))
      errors.push({ nodeId: n.id, message: `node '${n.id}' is unreachable from start` });
  }
  const ends = g.nodes.filter((n) => n.kind === 'end').map((n) => n.id);
  if (!ends.some((id) => reach.has(id)))
    errors.push({ message: 'no end node is reachable from start' });

  const canFinish = new Set<string>(ends);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of g.edges) {
      if (canFinish.has(e.to) && !canFinish.has(e.from)) {
        canFinish.add(e.from);
        grew = true;
      }
    }
  }
  for (const id of reach) {
    if (!canFinish.has(id))
      warnings.push({ nodeId: id, message: `no path from '${id}' to an end node` });
  }

  return { errors, warnings };
}

export function validatePattern(p: Pattern): ValidationReport {
  const report = validateGraph(p);
  const errors = [...report.errors];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.name)) {
    errors.push({ message: `pattern name '${p.name}' must be kebab-case` });
  }
  if (!p.description?.trim()) errors.push({ message: 'pattern needs a description' });
  const fields = new Set(p.state.map((f) => f.name));
  for (const k of p.requiredContext) {
    if (!fields.has(k)) errors.push({ message: `requiredContext '${k}' is not a state field` });
  }
  return { errors, warnings: report.warnings };
}
