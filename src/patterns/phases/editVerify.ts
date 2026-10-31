/**
 * Edit and verify: the shared second half of patterns that change code (fix,
 * refactor). The executor edits; the engine itself captures the diff and runs
 * the tests (and lint), so "it passed" and "nothing changed" are facts. A
 * failure is triaged before retrying:
 *
 * - PATCH: the edit is wrong or incomplete -> edit again with the failure.
 * - DIAGNOSIS: the plan or root cause is wrong -> back to diagnosis (bounded),
 *   when the pattern has one.
 * - ENVIRONMENT: not caused by the edit (flaky, missing dependency, failing
 *   before the change) -> stop; another edit cannot fix it.
 *
 * An empty edit, or one identical to the last attempt, is no progress: it goes
 * back to diagnosis or stops, instead of spending attempts on the same patch.
 */
import type { ScoreEdge, ScoreNode, StateField } from '../../core/types.js';
import type { Fragment } from './debate.js';

export interface EditVerifyConfig {
  /** What the executor must do, e.g. "Implement `plan` in `files`". */
  readonly applyDirective: string;
  /** Fields the executor reads besides the failure from the last attempt. */
  readonly applyReads: readonly string[];
  /** Extra fields the executor writes (e.g. noticedBugs). */
  readonly applyWrites?: readonly string[];
  /** Fields the triage reads to judge the failure (the plan, the root cause…). */
  readonly triageReads: readonly string[];
  /** Node to continue to when tests (and lint) pass. */
  readonly success: string;
  /** Node to continue to when attempts run out or the failure is environmental. */
  readonly giveUp: string;
  /**
   * Diagnosis to return to when the plan is wrong or nothing changed. Omit when
   * the pattern has none: a DIAGNOSIS failure is then retried as a PATCH.
   */
  readonly rediagnose?: {
    readonly node: string;
    /** string[] field the diagnosis researches; set to the failure. */
    readonly gaps: string;
  };
}

export const EDIT_STATE: readonly StateField[] = [
  {
    name: 'testCommand',
    type: 'string',
    description: "Command that runs the tests (empty: the project's test script)",
  },
  {
    name: 'lintCommand',
    type: 'string',
    description: 'Optional lint or typecheck command that must also pass',
  },
  { name: 'changes', type: 'string[]', description: 'Summary of each edit' },
  { name: 'diff', type: 'string', description: 'The workspace changes, captured by the engine' },
  { name: 'diffHash', type: 'string' },
  { name: 'prevDiffHash', type: 'string' },
  { name: 'changedFiles', type: 'string[]', description: 'Files the edit changed' },
  { name: 'testsPassed', type: 'boolean' },
  { name: 'testOutput', type: 'string', description: 'Test output, run by the engine' },
  { name: 'lintPassed', type: 'boolean', initial: true },
  { name: 'lintOutput', type: 'string' },
  {
    name: 'failureKind',
    type: 'string',
    description: 'PATCH | DIAGNOSIS | ENVIRONMENT | NO_PROGRESS',
  },
  { name: 'failureReason', type: 'string', description: 'Why the last attempt failed' },
  { name: 'attempts', type: 'number' },
  { name: 'maxAttempts', type: 'number', initial: 3 },
  { name: 'diagnoses', type: 'number', description: 'Times the diagnosis was redone' },
  { name: 'maxDiagnoses', type: 'number', initial: 1 },
];

/** Upper bound on visits to the loop's nodes: attempts per diagnosis × diagnoses, with room. */
const LOOP_VISITS = 20;
/** Raised to fit the counters you set: every attempt of every diagnosis, with room. */
const LOOP_FROM = '(maxAttempts + 1) * (maxDiagnoses + 1) + 4';

export function editVerifyPhase(cfg: EditVerifyConfig): Fragment {
  const re = cfg.rediagnose;
  const nodes: ScoreNode[] = [
    {
      id: 'apply',
      kind: 'agent',
      role: 'executor',
      label: 'Edit',
      directive: `${cfg.applyDirective} If \`failureReason\` is set, the last attempt failed: read \`testOutput\` and \`lintOutput\` and address the cause; do not repeat the same edit. Do not run the tests yourself to claim success: the engine runs them after you. Return one \`changes\` entry per edit (file: what changed).`,
      reads: [...cfg.applyReads, 'failureReason', 'testOutput', 'lintOutput', 'changedFiles'],
      writes: ['changes', ...(cfg.applyWrites ?? [])],
      maxVisits: LOOP_VISITS,
      visitsFrom: LOOP_FROM,
      retries: 2,
      checks: [{ expr: 'len(changes) > 0', message: 'List every edit you made in changes.' }],
    },
    {
      id: 'captureDiff',
      kind: 'tool',
      label: 'Capture diff',
      tool: 'git.diff',
      output: { diff: 'diff', hash: 'diffHash', files: 'changedFiles' },
      maxVisits: LOOP_VISITS,
      visitsFrom: LOOP_FROM,
    },
    {
      id: 'progressed',
      kind: 'condition',
      label: 'Anything new?',
      expression: 'len(changedFiles) > 0 && diffHash != prevDiffHash',
    },
    {
      id: 'noProgress',
      kind: 'compute',
      label: 'No progress',
      assign: [
        { field: 'failureKind', expr: '"NO_PROGRESS"' },
        {
          field: 'failureReason',
          expr: 'if(len(changedFiles) == 0, "the edit changed no files", "the edit is identical to the last attempt")',
        },
        { field: 'testsPassed', expr: 'false' },
      ],
    },
    {
      id: 'runTests',
      kind: 'tool',
      label: 'Run tests',
      tool: 'tests.run',
      inputs: { command: 'testCommand' },
      output: { passed: 'testsPassed', output: 'testOutput' },
      maxVisits: LOOP_VISITS,
      visitsFrom: LOOP_FROM,
    },
    {
      id: 'hasLint',
      kind: 'condition',
      label: 'Lint?',
      expression: '!empty(lintCommand)',
    },
    {
      id: 'runLint',
      kind: 'tool',
      label: 'Run lint',
      tool: 'tests.run',
      inputs: { command: 'lintCommand' },
      output: { passed: 'lintPassed', output: 'lintOutput' },
      maxVisits: LOOP_VISITS,
      visitsFrom: LOOP_FROM,
    },
    {
      id: 'countAttempt',
      kind: 'compute',
      label: 'Count attempt',
      assign: [
        { field: 'attempts', expr: 'attempts + 1' },
        { field: 'prevDiffHash', expr: 'diffHash' },
      ],
    },
    {
      id: 'verified',
      kind: 'condition',
      label: 'Tests pass?',
      expression: 'testsPassed && lintPassed',
    },
    {
      id: 'attemptsLeft',
      kind: 'condition',
      label: 'Attempts left?',
      expression: 'attempts < maxAttempts',
    },
    {
      id: 'triage',
      kind: 'agent',
      role: 'assessor',
      label: 'Triage failure',
      directive:
        'The edit was applied and the engine ran the checks: they failed. Read `testOutput`, `lintOutput`, `diff` and the plan, and classify the failure in `failureKind`: PATCH if the edit is wrong or incomplete but the plan is sound; DIAGNOSIS if the plan or root cause is wrong (the failure points elsewhere, or the edit cannot work); ENVIRONMENT if the failure is not caused by the edit (flaky test, missing dependency or tool, network, a test that also fails without the change). Put the specific evidence (test name, file:line, error) in `failureReason`.',
      reads: ['testOutput', 'lintOutput', 'diff', 'changes', ...cfg.triageReads],
      writes: ['failureKind', 'failureReason'],
      retries: 2,
      maxVisits: LOOP_VISITS,
      visitsFrom: LOOP_FROM,
      checks: [
        {
          expr: 'includes(["PATCH", "DIAGNOSIS", "ENVIRONMENT"], failureKind)',
          message: 'failureKind must be PATCH, DIAGNOSIS or ENVIRONMENT.',
        },
        { expr: 'len(failureReason) > 0', message: 'Give the evidence in failureReason.' },
      ],
    },
    {
      id: 'environmental',
      kind: 'condition',
      label: 'Environment?',
      expression: 'failureKind == "ENVIRONMENT"',
    },
  ];
  const edges: ScoreEdge[] = [
    { id: 'apply-captureDiff', from: 'apply', to: 'captureDiff' },
    { id: 'captureDiff-progressed', from: 'captureDiff', to: 'progressed' },
    { id: 'progressed-runTests', from: 'progressed', to: 'runTests', branch: 'then' },
    { id: 'progressed-noProgress', from: 'progressed', to: 'noProgress', branch: 'else' },
    { id: 'runTests-hasLint', from: 'runTests', to: 'hasLint' },
    { id: 'hasLint-runLint', from: 'hasLint', to: 'runLint', branch: 'then' },
    { id: 'hasLint-count', from: 'hasLint', to: 'countAttempt', branch: 'else' },
    { id: 'runLint-count', from: 'runLint', to: 'countAttempt' },
    { id: 'count-verified', from: 'countAttempt', to: 'verified' },
    { id: 'verified-success', from: 'verified', to: cfg.success, branch: 'then' },
    { id: 'verified-attemptsLeft', from: 'verified', to: 'attemptsLeft', branch: 'else' },
    { id: 'attemptsLeft-triage', from: 'attemptsLeft', to: 'triage', branch: 'then' },
    {
      id: 'attemptsLeft-giveUp',
      from: 'attemptsLeft',
      to: cfg.giveUp,
      branch: 'else',
      label: 'out of attempts',
    },
    { id: 'triage-environmental', from: 'triage', to: 'environmental' },
    {
      id: 'environmental-giveUp',
      from: 'environmental',
      to: cfg.giveUp,
      branch: 'then',
      label: 'not fixable by an edit',
    },
  ];
  const group = [
    'apply',
    'captureDiff',
    'progressed',
    'noProgress',
    'runTests',
    'hasLint',
    'runLint',
    'countAttempt',
    'verified',
    'attemptsLeft',
    'triage',
    'environmental',
  ];

  if (re) {
    nodes.push(
      {
        id: 'planWrong',
        kind: 'condition',
        label: 'Diagnosis wrong?',
        expression: 'failureKind == "DIAGNOSIS"',
      },
      {
        id: 'canRediagnose',
        kind: 'condition',
        label: 'Diagnose again?',
        expression: 'diagnoses < maxDiagnoses',
      },
      {
        id: 'rediagnose',
        kind: 'compute',
        label: 'Back to diagnosis',
        assign: [
          { field: re.gaps, expr: '[failureReason]' },
          { field: 'diagnoses', expr: 'diagnoses + 1' },
          { field: 'attempts', expr: '0' },
        ],
      },
    );
    edges.push(
      { id: 'environmental-planWrong', from: 'environmental', to: 'planWrong', branch: 'else' },
      { id: 'planWrong-canRediagnose', from: 'planWrong', to: 'canRediagnose', branch: 'then' },
      {
        id: 'planWrong-apply',
        from: 'planWrong',
        to: 'apply',
        branch: 'else',
        label: 'edit again',
      },
      { id: 'noProgress-canRediagnose', from: 'noProgress', to: 'canRediagnose' },
      { id: 'canRediagnose-rediagnose', from: 'canRediagnose', to: 'rediagnose', branch: 'then' },
      {
        id: 'canRediagnose-giveUp',
        from: 'canRediagnose',
        to: cfg.giveUp,
        branch: 'else',
        label: 'still wrong',
      },
      {
        id: 'rediagnose-node',
        from: 'rediagnose',
        to: re.node,
        label: 'diagnose again',
      },
    );
    group.push('planWrong', 'canRediagnose', 'rediagnose');
  } else {
    edges.push(
      {
        id: 'environmental-apply',
        from: 'environmental',
        to: 'apply',
        branch: 'else',
        label: 'edit again',
      },
      { id: 'noProgress-giveUp', from: 'noProgress', to: cfg.giveUp, label: 'no progress' },
    );
  }

  return {
    state: EDIT_STATE,
    nodes,
    edges,
    entry: 'apply',
    group: {
      id: 'editPhase',
      label: 'Edit and verify',
      description: 'Edit; the engine diffs and runs the tests; failures are triaged',
      nodes: group,
    },
  };
}
