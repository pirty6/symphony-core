/**
 * compileScore: Pattern + goal + context -> ExecutableScore. Pure.
 *
 * Same inputs always give the same id (generatedAt is excluded from the
 * hash). The result is deep-frozen: a Score is a read-only plan.
 */
import { hashOf } from './hash.js';
import { checkValue, zeroValue } from './schema.js';
import { isImprovisation } from './jazz.js';
import type { Complexity, ExecutableScore, Improvisation, Pattern } from './types.js';
import type { Issue } from './validate.js';
import { validatePattern } from './validate.js';

export const DEFAULT_MAX_STEPS = 100;
export const DEFAULT_COMPLEXITY: Complexity = 2;

export class CompileError extends Error {
  override name = 'CompileError';
  readonly issues: readonly Issue[];
  constructor(issues: readonly Issue[]) {
    super(`cannot compile: ${issues.map((i) => i.message).join('; ')}`);
    this.issues = issues;
  }
}

export interface CompileArgs {
  /** Ignored when the pattern has `goalFrom`: the goal is then that input's value. */
  readonly goal?: string;
  readonly complexity?: Complexity;
  readonly improvisation?: Improvisation;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly generatedAt?: string;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

type Hashable = Omit<ExecutableScore, 'id' | 'generatedAt'>;

export function scoreId(score: Hashable): string {
  const { schemaVersion, pattern, description, goal, context, state, nodes, edges, start } = score;
  return hashOf({
    schemaVersion,
    pattern,
    description,
    goal,
    context,
    state,
    nodes,
    edges,
    start,
    maxSteps: score.maxSteps,
    initialState: score.initialState,
    complexity: score.complexity,
    improvisation: score.improvisation,
    groups: score.groups,
    result: score.result,
  });
}

export function compileScore(pattern: Pattern, args: CompileArgs): ExecutableScore {
  const issues: Issue[] = [...validatePattern(pattern).errors];
  const context = { ...args.context };
  const fields = new Map(pattern.state.map((f) => [f.name, f]));

  for (const key of pattern.requiredContext) {
    const v = context[key];
    if (v === undefined || v === null || v === '') {
      issues.push({ message: `missing required context '${key}'` });
    }
  }
  for (const [key, value] of Object.entries(context)) {
    const field = fields.get(key);
    if (!field) {
      issues.push({ message: `context '${key}' is not a state field` });
      continue;
    }
    const err = checkValue(field.type, value);
    if (err) issues.push({ message: `context '${key}': ${err}` });
  }
  const fromInput = pattern.goalFrom ? context[pattern.goalFrom] : undefined;
  const goal = (
    pattern.goalFrom ? (typeof fromInput === 'string' ? fromInput : '') : (args.goal ?? '')
  ).trim();
  // A missing goal input is already reported as missing required context.
  if (!goal && !pattern.goalFrom) issues.push({ message: 'goal is required' });
  if (args.complexity !== undefined && ![1, 2, 3, 4].includes(args.complexity)) {
    issues.push({ message: 'complexity must be 1, 2, 3 or 4' });
  }
  if (args.improvisation !== undefined && !isImprovisation(args.improvisation)) {
    issues.push({ message: 'improvisation must be 0..4' });
  }
  if (issues.length > 0) throw new CompileError(issues);

  const complexity = args.complexity ?? pattern.complexity ?? DEFAULT_COMPLEXITY;
  const initialState: Record<string, unknown> = {};
  for (const f of pattern.state) {
    // A `complexity` field starts at the chosen complexity, or 0 ("auto": the pattern rates
    // the problem and sets it, see phases/complexity.ts); conditions scale the roster from it.
    const fallback =
      f.name === 'complexity' && f.type === 'number'
        ? (args.complexity ?? pattern.complexity ?? 0)
        : zeroValue(f.type);
    initialState[f.name] = structuredClone(context[f.name] ?? f.initial ?? fallback);
  }

  const body: Hashable = structuredClone({
    schemaVersion: 2 as const,
    pattern: pattern.name,
    description: pattern.description,
    goal,
    context,
    state: pattern.state,
    nodes: pattern.nodes,
    edges: pattern.edges,
    start: pattern.start,
    maxSteps: pattern.maxSteps ?? DEFAULT_MAX_STEPS,
    complexity,
    improvisation: args.improvisation ?? pattern.improvisation ?? 0,
    ...(pattern.groups ? { groups: pattern.groups } : {}),
    ...(pattern.result ? { result: pattern.result } : {}),
    initialState,
  });
  return deepFreeze({
    ...body,
    id: scoreId(body),
    generatedAt: args.generatedAt ?? new Date().toISOString(),
  });
}

/** Re-check a Score loaded from JSON: id integrity + graph validity. */
export function verifyScore(score: ExecutableScore): Issue[] {
  const issues: Issue[] = [];
  if (score.schemaVersion !== 2)
    issues.push({ message: `unsupported schemaVersion ${score.schemaVersion}` });
  const expected = scoreId(score);
  if (expected !== score.id) {
    issues.push({ message: `score id mismatch: content hashes to ${expected.slice(0, 12)}…` });
  }
  const report = validatePattern({ ...score, name: score.pattern, requiredContext: [] });
  return [...issues, ...report.errors];
}
