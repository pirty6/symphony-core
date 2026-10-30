import type { Pattern } from '../core/types.js';
import { challengePhase, hypothesesPhase, withState } from './phases/debate.js';
import { editVerifyPhase } from './phases/editVerify.js';
import { prReviewPhase } from './phases/prReview.js';
import { TESTS_KEPT_CHECK, testFirstPhase } from './phases/testFirst.js';
import {
  checkFindings,
  CITE_BY_ID,
  citesFindings,
  EVIDENCE_STATE,
  MEMORY_NOTE,
  MEMORY_STATE,
  MERGE_FINDINGS,
  recallMemory,
  rememberLessonNode,
} from './phases/evidence.js';

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

// The "hypotheses" here are competing approaches, including "it already exists".
const approaches = hypothesesPhase({
  subject: 'request',
  context: ['hint', 'knownFacts', 'pastLessons'],
});
const challenge = challengePhase({
  subject: 'request',
  evidence: 'findings',
  draft: 'design',
  gaps: 'gaps',
  reopen: 'explore',
  done: 'approve',
  research: ['hint', 'gaps'],
});
const edit = editVerifyPhase({
  applyDirective:
    'Implement `design` following `plan`, editing `files` (others only if the plan truly needs them) and following the conventions it names. The tests in `testFiles` were written first and fail now (`redOutput`): make them pass by changing the code. Do NOT edit `testFiles`: they are locked and the engine checks it; put any extra test in another file. Do not change unrelated behaviour. If `unmetCriteria` is set, the acceptance review found those criteria not met: address each one.',
  applyReads: [
    'request',
    'design',
    'plan',
    'files',
    'acceptanceCriteria',
    'testsToAdd',
    'testFiles',
    'redOutput',
    'unmetCriteria',
    'reviewComments',
  ],
  triageReads: ['request', 'design', 'plan'],
  success: TESTS_KEPT_CHECK,
  giveUp: 'learnFailed',
  rediagnose: { node: 'explore', gaps: 'gaps' },
});
const testFirst = testFirstPhase({
  subject: 'request',
  from: ['design', 'plan', 'files'],
  implement: 'apply',
  kept: 'review',
  stopped: 'testFirstStopped',
});
const prReview = prReviewPhase({
  subject: 'request',
  against: ['design', 'acceptanceCriteria'],
  edit: 'apply',
  approved: 'learnImplemented',
  stopped: 'reviewStopped',
});

/**
 * Implement = competing approaches (and a complexity rating) + evidence from the
 * code + a design with acceptance criteria that a skeptic attacks and you approve
 * + edit-and-verify + an acceptance review: passing tests are not enough, every
 * criterion must be met, with evidence, or the edit goes back (bounded).
 */
export const implement: Pattern = {
  name: 'implement',
  description:
    'Build a feature: competing approaches, a design with acceptance criteria you approve, edits verified by the tests, then a review that every criterion is met.',
  verbTriggers: ['implement', 'add', 'build', 'create', 'feature', 'support for', 'new command'],
  requiredContext: ['request'],
  goalFrom: 'request',
  result: [
    'reviewDecision',
    'reviewComments',
    'design',
    'acceptanceCriteria',
    'criteriaReport',
    'testFiles',
    'redReport',
    'changedFiles',
    'testsPassed',
    'unmetCriteria',
    'failureKind',
    'failureReason',
    'rulings',
    'unresolvedObjections',
  ],
  maxSteps: 400,
  state: withState(
    [
      {
        name: 'request',
        type: 'string',
        description: 'The feature: what it should do, for whom, and how you will know it works',
      },
      {
        name: 'hint',
        type: 'string',
        description: 'Optional: constraints, where it belongs, prior art',
      },
      { name: 'baselinePassed', type: 'boolean' },
      { name: 'baselineOutput', type: 'string', description: 'Tests before any edit' },
      { name: 'newFindings', type: 'string[]', description: 'Evidence found in this step' },
      {
        name: 'findings',
        type: 'string[]',
        description: 'Where the feature plugs in, conventions to follow, related tests',
      },
      { name: 'gaps', type: 'string[]', description: 'What exploring must settle next' },
      { name: 'design', type: 'string', description: 'The chosen approach and why, with evidence' },
      {
        name: 'acceptanceCriteria',
        type: 'string[]',
        description: 'Observable behaviour that proves the feature works, one per entry',
      },
      { name: 'testsToAdd', type: 'string[]', description: 'Tests that prove each criterion' },
      { name: 'files', type: 'string[]', description: 'Files to change or create' },
      { name: 'plan', type: 'string', description: 'Step-by-step implementation plan' },
      {
        name: 'criteriaReport',
        type: 'string[]',
        description: 'One entry per criterion: MET | NOT MET, with evidence',
      },
      { name: 'unmetCriteria', type: 'string[]', description: 'Criteria the review found unmet' },
      { name: 'reviews', type: 'number', description: 'Acceptance reviews sent back to editing' },
      { name: 'maxReviews', type: 'number', initial: 2 },
      ...EVIDENCE_STATE,
      ...MEMORY_STATE,
    ],
    approaches,
    challenge,
    testFirst,
    edit,
    prReview,
  ),
  start: 'start',
  groups: [
    {
      id: 'baselinePhase',
      label: 'Green baseline',
      description: 'Tests must pass before anything changes, or a failure could not be told apart',
      nodes: ['baseline', 'green', 'snapshot'],
    },
    { ...approaches.group, label: 'Competing approaches' },
    {
      id: 'designPhase',
      label: 'Design',
      description: 'Evidence for and against each approach, then a design with acceptance criteria',
      nodes: ['explore', 'checkExplore', 'mergeFindings', 'design'],
    },
    challenge.group,
    testFirst.group,
    edit.group,
    prReview.group,
    {
      id: 'acceptancePhase',
      label: 'Acceptance review',
      description: 'Every criterion met, with evidence; unmet ones go back to editing',
      nodes: ['review', 'allMet', 'reviewsLeft', 'backToEdit'],
    },
  ],
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'baseline',
      kind: 'tool',
      label: 'Run tests first',
      tool: 'tests.run',
      // An unchanged workspace (e.g. the next backlog item) reuses the last baseline.
      args: { reuse: true },
      inputs: { command: 'testCommand' },
      output: { passed: 'baselinePassed', output: 'baselineOutput' },
    },
    { id: 'green', kind: 'condition', label: 'Green?', expression: 'baselinePassed' },
    {
      id: 'snapshot',
      kind: 'tool',
      label: 'Snapshot workspace',
      tool: 'git.diff',
      // Edits must change the workspace from here; pre-existing changes are not progress.
      output: { hash: 'prevDiffHash' },
    },
    recallMemory('recall', 'request'),
    ...approaches.nodes,
    {
      id: 'explore',
      kind: 'agent',
      role: 'assessor',
      capabilities: ['web'],
      label: 'Explore the code',
      directive:
        'Read the code (no edits) for evidence on how to build `request`: for AND against every entry of `hypotheses` (each is an approach), tagging each finding with the approaches it bears on (e.g. "[H2 against]"). Find where the feature plugs in, similar features to copy the shape of, the conventions to follow (naming, errors, docs) and the tests that cover the area. If `gaps` is set, settle those first: they are objections to the last design or the reason the last edit failed. Record each fact in `newFindings`, without repeating `findings`.' +
        MEMORY_NOTE,
      reads: ['request', 'hint', 'hypotheses', 'findings', 'gaps', 'baselineOutput', 'knownFacts'],
      writes: ['newFindings'],
      cites: 'newFindings',
      retries: 2,
      maxVisits: 8,
      checks: [
        {
          expr: 'len(newFindings) > 0',
          message: 'Record at least one finding, with its location.',
        },
      ],
    },
    checkFindings('checkExplore'),
    {
      id: 'mergeFindings',
      kind: 'compute',
      label: 'Record evidence',
      assign: [...MERGE_FINDINGS, { field: 'gaps', expr: '[]' }],
    },
    {
      id: 'design',
      kind: 'agent',
      role: 'assessor',
      label: 'Design',
      directive:
        'From `findings` only, choose how to build `request` and write it in `design`, citing the evidence by id and naming the conventions to follow. ' +
        CITE_BY_ID +
        ' Rule on every approach in `rulings`, in order: "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence", where CONFIRMED is the approach you chose (if the feature already exists, confirm that and plan only what is missing). Write `acceptanceCriteria` as observable behaviour, one per entry, each checkable by a test; list those tests in `testsToAdd` (file and test name), the `files` to change or create, and a short step-by-step `plan`. If a previous attempt failed (`failureReason`, `testOutput`), the new design must say why it will not fail the same way.',
      reads: ['request', 'hint', 'hypotheses', 'findings', 'failureReason', 'testOutput'],
      writes: ['design', 'rulings', 'acceptanceCriteria', 'testsToAdd', 'files', 'plan'],
      verifyBelow: 0.6,
      retries: 2,
      complexityShift: 1,
      maxVisits: 8,
      checks: [
        { expr: 'len(design) > 0', message: 'Write the design.' },
        citesFindings('design'),
        {
          expr: 'len(acceptanceCriteria) > 0',
          message: 'List the acceptance criteria: observable behaviour a test can check.',
        },
        {
          expr: 'len(testsToAdd) > 0',
          message: 'List the tests that will prove the acceptance criteria.',
        },
        { expr: 'len(files) > 0', message: 'List the files to change or create.' },
        { expr: 'len(plan) > 0', message: 'Write the plan.' },
        {
          expr: 'len(rulings) == len(hypotheses)',
          message:
            'Give exactly one ruling per approach: "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence".',
        },
      ],
    },
    ...challenge.nodes,
    {
      id: 'approve',
      kind: 'approval',
      label: 'Approve design',
      message:
        'Review the design, the approaches ruled out and the acceptance criteria. Approve to let the executor write the tests first (they must fail), then the code; the engine runs the tests after every edit, then each criterion is reviewed.',
      writes: [],
      shows: ['design', 'acceptanceCriteria', 'testsToAdd', 'rulings', 'files', 'plan'],
    },
    ...testFirst.nodes,
    { id: 'testFirstStopped', kind: 'end', label: 'Stopped at tests', outcome: 'partial' },
    ...edit.nodes,
    ...prReview.nodes,
    { id: 'reviewStopped', kind: 'end', label: 'Stopped at review', outcome: 'partial' },
    {
      id: 'review',
      kind: 'agent',
      role: 'assessor',
      label: 'Acceptance review',
      maxVisits: 4,
      visitsFrom: 'maxReviews + 2',
      directive:
        'The tests and lint pass. Now check the change against `request`, not against the tests alone: for EVERY entry of `acceptanceCriteria`, in order, write one `criteriaReport` entry "C<n>: MET | NOT MET — evidence", where evidence is a test that checks it (file and name) or the code in `diff` that does it (path:line). A criterion with no test and no code that does it is NOT MET. Copy every NOT MET criterion, with what is missing, into `unmetCriteria` (empty when all are met).',
      reads: ['request', 'acceptanceCriteria', 'testsToAdd', 'diff', 'changes', 'testOutput'],
      writes: ['criteriaReport', 'unmetCriteria'],
      retries: 2,
      checks: [
        {
          expr: 'len(criteriaReport) == len(acceptanceCriteria)',
          message: 'Give exactly one criteriaReport entry per acceptance criterion, in order.',
        },
      ],
    },
    {
      id: 'allMet',
      kind: 'condition',
      label: 'All met?',
      expression: 'len(unmetCriteria) == 0',
    },
    {
      id: 'reviewsLeft',
      kind: 'condition',
      label: 'Review again?',
      expression: 'reviews < maxReviews',
    },
    {
      id: 'backToEdit',
      kind: 'compute',
      label: 'Back to editing',
      assign: [
        { field: 'reviews', expr: 'reviews + 1' },
        { field: 'failureKind', expr: '"UNMET"' },
        { field: 'failureReason', expr: '"acceptance criteria not met: see unmetCriteria"' },
      ],
    },
    rememberLessonNode('learnImplemented', 'implemented', {
      problem: 'request',
      cause: 'design',
      files: 'changedFiles',
    }),
    rememberLessonNode('learnFailed', 'failed', {
      problem: 'request',
      failure: 'failureReason',
      files: 'changedFiles',
    }),
    { id: 'implemented', kind: 'end', label: 'Implemented', outcome: 'success' },
    { id: 'incomplete', kind: 'end', label: 'Criteria unmet', outcome: 'partial' },
    { id: 'gaveUp', kind: 'end', label: 'Gave up', outcome: 'failed' },
    { id: 'notGreen', kind: 'end', label: 'Tests failing before', outcome: 'failed' },
    { id: 'rejected', kind: 'end', label: 'Design rejected', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-baseline', from: 'start', to: 'baseline' },
    { id: 'baseline-green', from: 'baseline', to: 'green' },
    { id: 'green-snapshot', from: 'green', to: 'snapshot', branch: 'then' },
    {
      id: 'green-notGreen',
      from: 'green',
      to: 'notGreen',
      branch: 'else',
      label: 'fix the tests first',
    },
    { id: 'snapshot-recall', from: 'snapshot', to: 'recall' },
    { id: 'recall-hypothesize', from: 'recall', to: approaches.entry },
    { id: 'learnImplemented-implemented', from: 'learnImplemented', to: 'implemented' },
    { id: 'learnFailed-gaveUp', from: 'learnFailed', to: 'gaveUp' },
    ...approaches.edges,
    { id: 'rating-explore', from: approaches.exit!, to: 'explore' },
    { id: 'explore-check', from: 'explore', to: 'checkExplore' },
    { id: 'check-merge', from: 'checkExplore', to: 'mergeFindings' },
    { id: 'merge-design', from: 'mergeFindings', to: 'design' },
    { id: 'design-challenge', from: 'design', to: challenge.entry },
    ...challenge.edges,
    { id: 'approve-tests', from: 'approve', to: testFirst.entry, branch: 'approved' },
    { id: 'approve-rejected', from: 'approve', to: 'rejected', branch: 'rejected' },
    ...testFirst.edges,
    ...edit.edges,
    ...prReview.edges,
    { id: 'review-allMet', from: 'review', to: 'allMet' },
    { id: 'allMet-prReview', from: 'allMet', to: 'prReview', branch: 'then' },
    { id: 'allMet-reviewsLeft', from: 'allMet', to: 'reviewsLeft', branch: 'else' },
    { id: 'reviewsLeft-back', from: 'reviewsLeft', to: 'backToEdit', branch: 'then' },
    {
      id: 'reviewsLeft-incomplete',
      from: 'reviewsLeft',
      to: 'incomplete',
      branch: 'else',
      label: 'still unmet',
    },
    { id: 'backToEdit-apply', from: 'backToEdit', to: 'apply', label: 'address unmet criteria' },
  ],
  demo: {
    context: { request: 'Add a --json flag to `todo list` that prints the items as JSON' },
    agents: {
      prReview: () => ({
        updates: {
          reviewDecision: 'APPROVE',
          reviewComments: [],
          reviewSummary: 'The change fixes the cause and the test covers it.',
        },
        verdict: v('approved'),
      }),
      hypothesize: () => ({
        updates: {
          ratedComplexity: 2,
          hypotheses: [
            'H1: add the flag to the list command and serialize the items | confirm if commands parse their own flags | refute if flags are parsed centrally',
            'H2: add a global --json output mode | confirm if other commands need JSON too | refute if only list prints data',
            'H3: it already exists (premise wrong) | confirm if list accepts --json | refute if it rejects the flag',
          ],
        },
        verdict: v('approaches proposed'),
      }),
      explore: () => ({
        updates: {
          newFindings: [
            'src/commands/list.ts:8 — list parses its own flags with parseArgs [H1 for]',
            'src/commands/*.ts — no other command prints data [H2 against]',
            'src/commands/list.ts:15 — unknown flags throw [H3 against]',
            'src/commands/list.test.ts — tests call run(["list", ...]) and capture stdout',
          ],
        },
        verdict: v('evidence gathered'),
      }),
      design: (s) => ({
        updates: {
          design:
            'Add a boolean `json` option to the parseArgs call in src/commands/list.ts:8 and print JSON.stringify(items) when set (H1) [F1][F4].',
          rulings: ((s.hypotheses as string[]) ?? []).map((h, i) =>
            i === 0
              ? `${h.split(':')[0]}: CONFIRMED — src/commands/list.ts:8`
              : `${h.split(':')[0]}: REFUTED — ${i === 1 ? 'no other command prints data' : 'src/commands/list.ts:15'}`,
          ),
          acceptanceCriteria: [
            '`todo list --json` prints a JSON array of the items',
            '`todo list` without the flag prints the same text as before',
          ],
          testsToAdd: [
            'src/commands/list.test.ts "prints JSON with --json"',
            'src/commands/list.test.ts "prints text by default"',
          ],
          files: ['src/commands/list.ts', 'src/commands/list.test.ts'],
          plan: '1. add the json option\n2. branch on it when printing\n3. add both tests',
        },
        verdict: v('designed'),
      }),
      challenge: () => ({ updates: { objections: [] }, verdict: v('the design stands') }),
      writeTests: () => ({
        updates: { testFiles: ['src/commands/list.test.ts'] },
        verdict: v('tests written'),
      }),
      checkRed: () => ({
        updates: {
          redReport: [
            'C1: RED — "prints JSON with --json" — list rejects the unknown option --json',
            'C2: RED — "prints text by default" — expects no trailing blank line; list prints one',
          ],
          wrongRed: [],
        },
        verdict: v('red for the right reason'),
      }),
      apply: (_s, visit) => ({
        updates: {
          changes:
            visit === 0
              ? ['src/commands/list.ts: --json prints JSON.stringify(items)']
              : ['src/commands/list.ts: --json output ends with a newline like the text output'],
        },
        verdict: v('edited'),
      }),
      review: (_s, visit) => ({
        updates:
          visit === 0
            ? {
                criteriaReport: [
                  'C1: NOT MET — src/commands/list.ts:21 the JSON has no trailing newline, unlike every other output',
                  'C2: MET — src/commands/list.test.ts "prints text by default"',
                ],
                unmetCriteria: ['C1: end the JSON output with a newline'],
              }
            : {
                criteriaReport: [
                  'C1: MET — src/commands/list.test.ts "prints JSON with --json"',
                  'C2: MET — src/commands/list.test.ts "prints text by default"',
                ],
                unmetCriteria: [],
              },
        verdict: v('reviewed'),
      }),
      triage: () => ({
        updates: { failureKind: 'PATCH', failureReason: 'the JSON test failed' },
        verdict: v('triaged'),
      }),
    },
    tools: {
      recall: () => ({ facts: [], lessons: [] }),
      learnImplemented: () => ({ saved: true }),
      learnFailed: () => ({ saved: true }),
      checkExplore: (s) => ({ valid: s.newFindings, invalid: [] }),
      baseline: () => ({ passed: true, output: 'Tests 20 passed', command: 'npm test' }),
      snapshot: () => ({ diff: '', hash: 'base', files: [] }),
      captureTests: () => ({
        diff: '+++ b/src/commands/list.test.ts\n+  it("prints JSON with --json", …)',
        hash: 'tests-1',
        files: ['src/commands/list.test.ts'],
      }),
      runRed: () => ({
        passed: false,
        output: 'FAIL src/commands/list.test.ts > prints JSON with --json: unknown option --json',
        command: 'npm test',
      }),
      lockTests: () => ({ diff: '', hash: 'locked', files: ['src/commands/list.test.ts'] }),
      checkTests: () => ({ diff: '', hash: 'locked', files: ['src/commands/list.test.ts'] }),
      captureDiff: (s) => {
        const n = (s.attempts as number) ?? 0;
        return {
          diff: `--- a/src/commands/list.ts\n+++ b/src/commands/list.ts\n+  json: { type: 'boolean' }, attempt ${n + 1}`,
          hash: `implement-${n + 1}`,
          files: ['src/commands/list.test.ts', 'src/commands/list.ts'],
        };
      },
      runTests: () => ({ passed: true, output: 'Tests 22 passed', command: 'npm test' }),
    },
    approvals: { approve: () => ({ approved: true }) },
  },
};
