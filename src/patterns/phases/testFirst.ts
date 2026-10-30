/**
 * Tests first: before any implementation, the executor writes the tests that
 * prove the acceptance criteria, and the engine proves they fail:
 *
 * 1. The test step may change only the files it lists in `testFiles` (git diff).
 * 2. The engine runs the tests: the suite must fail (passing tests check nothing new;
 *    tests that existing behaviour stays the same are guards and may pass).
 * 3. An assessor checks they fail for the right reason (the behaviour is
 *    missing), not a syntax error or a broken test.
 * 4. The engine hashes `testFiles` (locked). Once the implementation is green,
 *    the hash must be the same: the tests were not bent to fit the code. If they
 *    changed, a person decides.
 *
 * Retries are bounded (maxRedAttempts); after them a person decides whether to
 * implement anyway or stop.
 */
import type { ScoreEdge, ScoreNode, StateField } from '../../core/types.js';
import type { Fragment } from './debate.js';

export interface TestFirstConfig {
  /** What the change is for (e.g. request). */
  readonly subject: string;
  /** The design fields the tests are written from. */
  readonly from: readonly string[];
  /** The implementation step, once the tests are red and locked (editVerify's entry). */
  readonly implement: string;
  /** Where to go once the implementation is green and the tests are untouched (from TESTS_KEPT_CHECK). */
  readonly kept: string;
  /** Where to go when a person stops it. */
  readonly stopped: string;
}

export const TEST_FIRST_STATE: readonly StateField[] = [
  {
    name: 'testFiles',
    type: 'string[]',
    description: 'Files the tests were written in; locked once they fail',
  },
  { name: 'redOutput', type: 'string', description: 'Test output before the implementation' },
  {
    name: 'redReport',
    type: 'string[]',
    description: 'One per criterion: "C<n>: RED | GUARD | NOT RED — test — why"',
  },
  {
    name: 'wrongRed',
    type: 'string[]',
    description: 'Tests failing for the wrong reason, or criteria without a failing test',
  },
  { name: 'redFeedback', type: 'string', description: 'Why the last tests were not accepted' },
  { name: 'redAttempts', type: 'number', description: 'Times the tests were written again' },
  { name: 'maxRedAttempts', type: 'number', initial: 2 },
  { name: 'testsHash', type: 'string', description: 'Hash of testFiles when locked' },
  { name: 'testsNowHash', type: 'string' },
  { name: 'testsDiff', type: 'string', description: 'How the implementation changed testFiles' },
];

/** Node to continue to once the implementation is green: it checks the locked tests. */
export const TESTS_KEPT_CHECK = 'checkTests';

/** Bound on the test-writing loop: (maxRedAttempts + 1) per design, with room for a re-design. */
const RED_VISITS = 8;

/** Record why the tests were not accepted, before trying again. */
const retry = (id: string, why: string): ScoreNode => ({
  id,
  kind: 'compute',
  label: 'Not accepted',
  assign: [{ field: 'redFeedback', expr: why }],
});

export function testFirstPhase(cfg: TestFirstConfig): Fragment {
  const nodes: ScoreNode[] = [
    {
      id: 'writeTests',
      kind: 'agent',
      role: 'executor',
      label: 'Write tests first',
      maxVisits: RED_VISITS,
      visitsFrom: '(maxRedAttempts + 1) * 3',
      retries: 2,
      directive: `Write ONLY the tests in \`testsToAdd\`, so that every entry of \`acceptanceCriteria\` is checked by a test, following the project's test conventions. Do NOT implement \`${cfg.subject}\` and do not change any non-test file: the tests for new behaviour must fail now, because it does not exist yet, and the engine checks that the suite fails. A criterion that existing behaviour stays the same is a guard: its test passes now, and that is right. Test the behaviour the criteria describe (inputs and observable output), not implementation details, so any correct implementation passes. List every file you changed in \`testFiles\`. If \`redFeedback\` is set, your last tests were not accepted: fix what it says (see \`wrongRed\` and \`redOutput\`).`,
      reads: [
        cfg.subject,
        ...cfg.from,
        'acceptanceCriteria',
        'testsToAdd',
        'redFeedback',
        'wrongRed',
        'redOutput',
      ],
      writes: ['testFiles'],
      checks: [
        { expr: 'len(testFiles) > 0', message: 'List the test files you wrote in testFiles.' },
      ],
    },
    {
      id: 'captureTests',
      kind: 'tool',
      label: 'Capture tests',
      tool: 'git.diff',
      output: { diff: 'diff', hash: 'diffHash', files: 'changedFiles' },
      maxVisits: RED_VISITS,
      visitsFrom: '(maxRedAttempts + 1) * 3',
    },
    {
      id: 'onlyTests',
      kind: 'condition',
      label: 'Only tests changed?',
      expression: 'len(changedFiles) > 0 && subset(changedFiles, testFiles)',
    },
    retry(
      'notOnlyTests',
      'if(len(changedFiles) == 0, "no file changed: write the tests", "change only the test files listed in testFiles: changedFiles has others; undo those changes")',
    ),
    {
      id: 'runRed',
      kind: 'tool',
      label: 'Run tests (must fail)',
      tool: 'tests.run',
      inputs: { command: 'testCommand' },
      output: { passed: 'testsPassed', output: 'redOutput' },
      maxVisits: RED_VISITS,
      visitsFrom: '(maxRedAttempts + 1) * 3',
    },
    { id: 'isRed', kind: 'condition', label: 'Red?', expression: '!testsPassed' },
    retry(
      'stillGreen',
      '"the tests pass before any implementation: they do not check the new behaviour"',
    ),
    {
      id: 'checkRed',
      kind: 'agent',
      role: 'assessor',
      label: 'Failing for the right reason?',
      maxVisits: RED_VISITS,
      visitsFrom: '(maxRedAttempts + 1) * 3',
      retries: 2,
      directive:
        'The tests in `testFiles` were written before the implementation and the suite fails (`redOutput`). For EVERY entry of `acceptanceCriteria`, in order, write one `redReport` entry "C<n>: RED | GUARD | NOT RED — test name — why". RED: a test for new behaviour fails for the right reason, the behaviour is missing (wrong or no output, an unknown option, a function or module that does not exist yet). GUARD: the criterion is that existing behaviour stays the same, and its test passes now (that is right, it guards the change). NOT RED: anything else. Wrong reasons: a syntax or type error in the test itself, a broken import of a test helper, a typo, a test for new behaviour that passes now or would pass with a wrong implementation, other tests that were already failing, or a criterion no test checks. Copy every NOT RED entry, with what is wrong, into `wrongRed` (empty when every criterion is RED or GUARD).',
      reads: ['acceptanceCriteria', 'testsToAdd', 'testFiles', 'redOutput', 'diff'],
      writes: ['redReport', 'wrongRed'],
      checks: [
        {
          expr: 'len(redReport) == len(acceptanceCriteria)',
          message: 'Give exactly one redReport entry per acceptance criterion, in order.',
        },
      ],
    },
    {
      id: 'rightReason',
      kind: 'condition',
      label: 'Right reason?',
      expression: 'len(wrongRed) == 0',
    },
    retry(
      'wrongReason',
      '"some tests fail for the wrong reason, or a criterion has no failing test: see wrongRed"',
    ),
    {
      id: 'redLeft',
      kind: 'condition',
      label: 'Try again?',
      expression: 'redAttempts < maxRedAttempts',
    },
    {
      id: 'retryTests',
      kind: 'compute',
      label: 'Write them again',
      assign: [{ field: 'redAttempts', expr: 'redAttempts + 1' }],
    },
    {
      id: 'notRed',
      kind: 'approval',
      label: 'Implement anyway?',
      message:
        'The tests written first still do not fail for the right reason (see redFeedback). Approve to lock them as they are and implement anyway, or reject to stop.',
      writes: [],
      shows: ['redFeedback', 'redReport', 'wrongRed', 'testFiles', 'redOutput'],
    },
    {
      id: 'lockTests',
      kind: 'tool',
      label: 'Lock tests',
      tool: 'git.diff',
      inputs: { paths: 'testFiles' },
      output: { hash: 'testsHash' },
      maxVisits: RED_VISITS,
      visitsFrom: '(maxRedAttempts + 1) * 3',
    },
    {
      id: 'redBase',
      kind: 'compute',
      label: 'Tests are the base',
      // The implementation must change more than the tests; it starts with no failure to fix.
      assign: [
        { field: 'prevDiffHash', expr: 'diffHash' },
        { field: 'failureKind', expr: '""' },
        { field: 'failureReason', expr: '""' },
      ],
    },
    {
      id: TESTS_KEPT_CHECK,
      kind: 'tool',
      label: 'Tests untouched?',
      tool: 'git.diff',
      inputs: { paths: 'testFiles' },
      output: { hash: 'testsNowHash', diff: 'testsDiff' },
      maxVisits: 20,
    },
    {
      id: 'testsKept',
      kind: 'condition',
      label: 'Same tests?',
      expression: 'testsNowHash == testsHash',
    },
    {
      id: 'testsChanged',
      kind: 'approval',
      label: 'Tests were changed',
      message:
        'The implementation passes, but it changed the tests that were written first (see testsDiff), so they may have been bent to fit the code. Approve to accept the changed tests, or reject to stop.',
      writes: [],
      shows: ['testFiles', 'testsDiff', 'changes'],
    },
  ];
  const edges: ScoreEdge[] = [
    { id: 'writeTests-capture', from: 'writeTests', to: 'captureTests' },
    { id: 'captureTests-only', from: 'captureTests', to: 'onlyTests' },
    { id: 'onlyTests-run', from: 'onlyTests', to: 'runRed', branch: 'then' },
    { id: 'onlyTests-not', from: 'onlyTests', to: 'notOnlyTests', branch: 'else' },
    { id: 'notOnlyTests-left', from: 'notOnlyTests', to: 'redLeft' },
    { id: 'runRed-isRed', from: 'runRed', to: 'isRed' },
    { id: 'isRed-check', from: 'isRed', to: 'checkRed', branch: 'then' },
    { id: 'isRed-green', from: 'isRed', to: 'stillGreen', branch: 'else' },
    { id: 'stillGreen-left', from: 'stillGreen', to: 'redLeft' },
    { id: 'checkRed-reason', from: 'checkRed', to: 'rightReason' },
    { id: 'rightReason-lock', from: 'rightReason', to: 'lockTests', branch: 'then' },
    { id: 'rightReason-wrong', from: 'rightReason', to: 'wrongReason', branch: 'else' },
    { id: 'wrongReason-left', from: 'wrongReason', to: 'redLeft' },
    { id: 'redLeft-retry', from: 'redLeft', to: 'retryTests', branch: 'then' },
    { id: 'redLeft-ask', from: 'redLeft', to: 'notRed', branch: 'else', label: 'still not red' },
    { id: 'retryTests-write', from: 'retryTests', to: 'writeTests', label: 'with feedback' },
    { id: 'notRed-lock', from: 'notRed', to: 'lockTests', branch: 'approved' },
    { id: 'notRed-stop', from: 'notRed', to: cfg.stopped, branch: 'rejected' },
    { id: 'lockTests-base', from: 'lockTests', to: 'redBase' },
    { id: 'redBase-implement', from: 'redBase', to: cfg.implement, label: 'make them pass' },
    { id: 'checkTests-kept', from: 'checkTests', to: 'testsKept' },
    { id: 'testsKept-yes', from: 'testsKept', to: cfg.kept, branch: 'then' },
    { id: 'testsKept-no', from: 'testsKept', to: 'testsChanged', branch: 'else' },
    { id: 'testsChanged-accept', from: 'testsChanged', to: cfg.kept, branch: 'approved' },
    { id: 'testsChanged-stop', from: 'testsChanged', to: cfg.stopped, branch: 'rejected' },
  ];
  return {
    state: TEST_FIRST_STATE,
    nodes,
    edges,
    entry: 'writeTests',
    group: {
      id: 'testFirstPhase',
      label: 'Tests first',
      description: 'Tests written before the code must fail for the right reason, then stay locked',
      nodes: nodes.map((n) => n.id),
    },
  };
}
