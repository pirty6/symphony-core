import type { Pattern } from '../core/types.js';
import { challengePhase, hypothesesPhase, withState } from './phases/debate.js';
import { editVerifyPhase } from './phases/editVerify.js';
import { prReviewPhase } from './phases/prReview.js';
import { stabilityPhases, targetFailed } from './phases/stability.js';
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

/** Where intermittent failures come from (Luo et al. 2014, Fowler, Parry et al. 2021). */
const NONDETERMINISM =
  ' If the failure is intermittent (it passes on a re-run, only under load, only in CI or in some test orders), look for the usual causes of nondeterminism: waiting for async work by time instead of on the event, a race between concurrent code, state shared between tests or left behind by one (test order), leaked resources (ports, files, timers, handles), the real clock or time zone, randomness, unordered collections, the network or another service, and limits such as timeouts and parallel workers under load.';
/** Edits that make a flaky test pass without fixing it. */
const MASKING =
  'retries, skip, todo or expected-fail markers, removed or loosened assertions, longer sleeps or timeouts, wider tolerances or slack, fewer workers, or quarantining the test';

const hypotheses = hypothesesPhase({
  subject: 'issue',
  context: ['hint', 'knownFacts', 'pastLessons'],
});
const challenge = challengePhase({
  subject: 'issue',
  // The debaters read findings without their (already checked) quotes, as in investigate.
  evidence: 'findingsBrief',
  draft: 'rootCause',
  gaps: 'gaps',
  reopen: 'research',
  done: 'approve',
  research: ['hint', 'gaps'],
});
const edit = editVerifyPhase({
  applyDirective:
    'Implement `plan` by editing `files` (others only if the plan truly needs them). Fix the root cause in `rootCause`, not the symptom, and add or update a test that fails without the fix when that is feasible. ' +
    `Do not hide a failure instead of fixing it (${MASKING}), unless the plan shows the old limit was wrong for work measured to take that long: then say so in \`changes\`.`,
  applyReads: ['issue', 'rootCause', 'files', 'plan', 'reviewComments'],
  triageReads: ['issue', 'rootCause', 'plan', 'flakyTarget'],
  triageNote:
    ' A failure of the intermittent test this fix is about (`flakyTarget`) is never ENVIRONMENT: the patch did not make it stable.',
  triageChecks: [
    {
      expr: `failureKind != "ENVIRONMENT" || !(${targetFailed('testOutput')})`,
      message:
        'The test this fix is about (flakyTarget) failed: the patch did not make it stable. Classify it PATCH or DIAGNOSIS.',
    },
    {
      expr: 'failureKind != "ENVIRONMENT" || unstableHash != diffHash',
      message:
        'The stability gate ran this patch again and the flaky test failed: classify it PATCH or DIAGNOSIS.',
    },
  ],
  // The stability gate (off by default), then with reproduceFirst the locked test, then review.
  success: 'stableGate',
  giveUp: 'learnFailed',
  reviewedExit: 'reviewedCertified',
  rediagnose: { node: 'research', gaps: 'gaps' },
});
/** reproduceFirst (opt-in): a test that reproduces the bug, proved red and locked before the edit. */
const reproduce = testFirstPhase({
  subject: 'issue',
  from: ['rootCause', 'plan'],
  implement: 'apply',
  kept: 'prReview',
  stopped: 'reviewStopped',
});
const prReview = prReviewPhase({
  subject: 'issue',
  against: ['rootCause', 'plan'],
  edit: 'apply',
  approved: 'learnFixed',
  stopped: 'reviewStopped',
  reviewNote: ` When \`stabilityReport\` is set, the engine ran the flaky test again and again: read it and \`maskingFlags\`. ${MASKING[0]!.toUpperCase()}${MASKING.slice(1)}, or removed assertions, make a flaky test pass without fixing it: BLOCKING, unless the change shows the old limit was wrong for work measured to take that long (not merely slower under load).`,
  reviewReads: ['stabilityReport', 'maskingFlags'],
});
/** The stability gate for a flaky test (opt-in): control before the edit, fresh runs after. */
const stability = stabilityPhases({
  next: 'reproduceFirstOn',
  passed: 'reproduced',
  unstable: 'attemptsLeft',
  uncertified: 'learnUncertified',
  reviewed: 'acceptAnyway',
});

/**
 * Fix = investigate's diagnosis (competing hypotheses, evidence for and against,
 * a skeptic) + edit-and-verify (the engine runs the tests; failures are triaged
 * and a wrong diagnosis is redone, bounded).
 */
export const fix: Pattern = {
  name: 'fix',
  description:
    'Fix a bug: competing hypotheses, evidence, a diagnosis you approve, then edit while the engine runs the tests; wrong diagnoses are redone.',
  verbTriggers: ['fix', 'bug', 'broken', 'repair', 'crash', 'failing'],
  requiredContext: ['issue'],
  goalFrom: 'issue',
  result: [
    'reviewDecision',
    'reviewComments',
    'rootCause',
    'plan',
    'changedFiles',
    'testsPassed',
    'failureKind',
    'failureReason',
    'rulings',
    'unresolvedObjections',
    'stabilityReport',
    'maskingFlags',
  ],
  maxSteps: 400,
  state: withState(
    [
      {
        name: 'issue',
        type: 'string',
        description: 'The bug: symptom, how to reproduce, expected',
      },
      { name: 'hint', type: 'string', description: 'Optional: where to look, what you suspect' },
      { name: 'newFindings', type: 'string[]', description: 'Evidence found in this step' },
      { name: 'findings', type: 'string[]', description: 'All evidence, each with its location' },
      { name: 'gaps', type: 'string[]', description: 'What the research must settle next' },
      { name: 'rootCause', type: 'string', description: 'The root cause, with evidence' },
      { name: 'files', type: 'string[]', description: 'Files to change' },
      { name: 'plan', type: 'string', description: 'Step-by-step fix plan' },
      {
        name: 'nondeterministic',
        type: 'boolean',
        description: 'The diagnosis: the failure is intermittent',
      },
      {
        name: 'flakyTarget',
        type: 'string',
        description: 'The intermittent test, as the test runner prints it',
      },
      { name: 'flakyFile', type: 'string', description: "flakyTarget's test file" },
      {
        name: 'fixTarget',
        type: 'string',
        description: 'Where an intermittent failure is fixed: CODE | TEST | ENVIRONMENT',
      },
      {
        name: 'hypothesesPerResearch',
        type: 'number',
        initial: 99,
        min: 1,
        description:
          'Hypotheses per research sub-agent (99: one call for all; 1: one sub-agent each, sooner, more tokens)',
      },
      {
        name: 'reproduceFirst',
        type: 'boolean',
        description:
          'Opt-in: before the fix, a test that reproduces the bug is written, proved to fail for the right reason, and locked',
      },
      {
        name: 'acceptanceCriteria',
        type: 'string[]',
        description: 'With reproduceFirst: what the fix makes true, one per entry ("C1: …")',
      },
      {
        name: 'testsToAdd',
        type: 'string[]',
        description: 'With reproduceFirst: the tests that reproduce the bug',
      },
      ...EVIDENCE_STATE,
      ...MEMORY_STATE,
    ],
    hypotheses,
    challenge,
    edit,
    reproduce,
    prReview,
    stability.control,
    stability.gate,
  ),
  start: 'start',
  groups: [
    hypotheses.group,
    {
      id: 'diagnosePhase',
      label: 'Diagnose',
      description: 'Evidence for and against every hypothesis, then the root cause',
      nodes: ['research', 'checkResearch', 'mergeResearch', 'diagnose'],
    },
    challenge.group,
    stability.control.group,
    { ...reproduce.group, nodes: ['planReproduce', ...reproduce.group.nodes] },
    edit.group,
    stability.gate.group,
    prReview.group,
  ],
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'baseline',
      kind: 'tool',
      label: 'Run tests first',
      tool: 'tests.run',
      // What fails before any edit: the bug's symptom, or tests already broken (not the fix's).
      args: { reuse: true },
      inputs: { command: 'testCommand', timeoutMs: 'testTimeoutMs' },
      // The command it ran is kept: an edit to the test script cannot change what verifies it.
      output: { passed: 'baselinePassed', output: 'baselineOutput', command: 'testCommand' },
    },
    {
      id: 'snapshot',
      kind: 'tool',
      label: 'Snapshot workspace',
      tool: 'git.diff',
      // Edits must change the workspace from here; changes already there are not a fix.
      output: { hash: 'baseDiffHash' },
    },
    recallMemory('recall', 'issue'),
    ...hypotheses.nodes,
    {
      id: 'research',
      kind: 'agent',
      role: 'assessor',
      capabilities: ['web'],
      label: 'Gather evidence',
      // hypothesesPerResearch (a trial; 99: one call): parallel sub-agents, each on some hypotheses.
      fanOut: { over: 'hypotheses', per: 'hypothesesPerResearch', warm: true },
      directive:
        'Read the code (no edits) for evidence on `issue`: for AND against every entry of `hypotheses`, tagging each finding with the hypotheses it bears on (e.g. "[H2 against]"). Find the code path that produces the symptom, the tests that cover it, and recent changes to it (git log -p, git blame).' +
        NONDETERMINISM +
        ' If `gaps` is set, settle those first: they are objections to the last diagnosis or the reason the last fix failed. Record each fact in `newFindings`, without repeating the findings so far (`findingsBrief`: each with its id and location, quotes left out).' +
        MEMORY_NOTE,
      // The brief, not the full findings: they grow every round; diagnose reads them in full.
      reads: ['issue', 'hint', 'hypotheses', 'findingsBrief', 'gaps', 'knownFacts'],
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
    checkFindings('checkResearch'),
    {
      id: 'mergeResearch',
      kind: 'compute',
      label: 'Record evidence',
      assign: [...MERGE_FINDINGS, { field: 'gaps', expr: '[]' }],
    },
    {
      id: 'diagnose',
      kind: 'agent',
      role: 'assessor',
      label: 'Diagnose',
      directive:
        'From `findings` only, state the root cause of `issue` in `rootCause`, citing the evidence by id. ' +
        CITE_BY_ID +
        ' Rule on every hypothesis in `rulings`, in order: "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence". List the files to change in `files` and a short step-by-step `plan` that fixes the cause (not the symptom) and adds a test. If a previous fix failed (`failureReason`, `testOutput`), the new plan must explain why it will not fail the same way. `baselineOutput` is the test run before any edit: tests failing there that the bug does not explain are not yours to fix.' +
        NONDETERMINISM +
        ` Set \`nondeterministic\` when the failure is intermittent. Then name the test in \`flakyTarget\` exactly as the test runner prints it (vitest: "src/a.test.ts > suite > test"), its file in \`flakyFile\`, and in \`fixTarget\` where the cause is: CODE (the code under test, e.g. a race or a real-clock comparison), TEST (the test waits by time, depends on order or leaks state) or ENVIRONMENT (the machine, not this repository). ${MASKING[0]!.toUpperCase()}${MASKING.slice(1)} hide a flaky test; they do not fix it.`,
      reads: [
        'issue',
        'hint',
        'hypotheses',
        'findings',
        'failureReason',
        'testOutput',
        'baselineOutput',
      ],
      writes: [
        'rootCause',
        'files',
        'plan',
        'rulings',
        'nondeterministic',
        'flakyTarget',
        'flakyFile',
        'fixTarget',
      ],
      verifyBelow: 0.6,
      retries: 2,
      complexityShift: 1,
      maxVisits: 8,
      checks: [
        { expr: 'len(rootCause) > 0', message: 'State the root cause.' },
        citesFindings('rootCause'),
        { expr: 'len(files) > 0', message: 'List the files to change.' },
        { expr: 'len(plan) > 0', message: 'Write the plan.' },
        {
          expr: 'len(rulings) == len(hypotheses)',
          message:
            'Give exactly one ruling per hypothesis: "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence".',
        },
        {
          expr: '!nondeterministic || (!empty(flakyTarget) && includes(["CODE", "TEST", "ENVIRONMENT"], fixTarget))',
          message:
            'An intermittent failure needs flakyTarget (the test, as the runner prints it) and fixTarget: CODE, TEST or ENVIRONMENT.',
        },
        {
          expr: 'empty(flakyTarget) || (!empty(flakyFile) && includes(flakyTarget, flakyFile))',
          message: "Give flakyTarget's test file in flakyFile, as it appears in flakyTarget.",
        },
      ],
    },
    ...challenge.nodes,
    {
      id: 'approve',
      kind: 'approval',
      label: 'Approve plan',
      message:
        'Review the root cause, the hypotheses ruled out and the plan. Approve to let the executor edit files; the engine will run the tests.',
      writes: [],
      shows: ['rootCause', 'rulings', 'files', 'plan'],
    },
    {
      id: 'reproduceFirstOn',
      kind: 'condition',
      label: 'Reproduce first?',
      expression: 'reproduceFirst',
    },
    {
      id: 'planReproduce',
      kind: 'agent',
      role: 'assessor',
      label: 'Plan the reproducing test',
      directive:
        'Before the fix, a test must reproduce the bug. From `issue`, `rootCause` and `plan`, write `acceptanceCriteria`: what the fix makes true, observable from outside ("C1: …", one per entry), and `testsToAdd`: the tests that reproduce the bug (file, input, expected), following the project\'s test conventions. They are written next and must fail now, for this bug.',
      reads: ['issue', 'rootCause', 'plan', 'files', 'baselineOutput'],
      writes: ['acceptanceCriteria', 'testsToAdd'],
      retries: 2,
      maxVisits: 4,
      // Planned again after each re-diagnosis.
      visitsFrom: 'maxDiagnoses + 2',
      checks: [
        {
          expr: 'len(acceptanceCriteria) > 0 && len(unmatched(acceptanceCriteria, "^C[0-9]+: ")) == 0',
          message: 'Write each acceptanceCriteria entry as "C<n>: what the fix makes true".',
        },
        { expr: 'len(testsToAdd) > 0', message: 'List the tests that reproduce the bug.' },
      ],
    },
    {
      id: 'reproduced',
      kind: 'condition',
      label: 'Tests locked?',
      expression: '!empty(testsHash)',
    },
    ...reproduce.nodes,
    ...edit.nodes,
    ...stability.control.nodes,
    ...stability.gate.nodes,
    ...prReview.nodes,
    { id: 'reviewStopped', kind: 'end', label: 'Stopped at review', outcome: 'partial' },
    rememberLessonNode('learnFixed', 'fixed', {
      problem: 'issue',
      cause: 'rootCause',
      files: 'changedFiles',
    }),
    rememberLessonNode('learnFailed', 'failed', {
      problem: 'issue',
      failure: 'failureReason',
      files: 'changedFiles',
    }),
    rememberLessonNode(
      'learnUncertified',
      'fixed',
      { problem: 'issue', cause: 'rootCause', files: 'changedFiles' },
      { outcome: 'partial' },
    ),
    { id: 'fixed', kind: 'end', label: 'Fixed', outcome: 'success' },
    { id: 'uncertified', kind: 'end', label: 'Not certified', outcome: 'partial' },
    { id: 'gaveUp', kind: 'end', label: 'Gave up', outcome: 'failed' },
    { id: 'rejected', kind: 'end', label: 'Plan rejected', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-baseline', from: 'start', to: 'baseline' },
    { id: 'baseline-snapshot', from: 'baseline', to: 'snapshot' },
    { id: 'snapshot-recall', from: 'snapshot', to: 'recall' },
    { id: 'recall-hypothesize', from: 'recall', to: hypotheses.entry },
    { id: 'learnFixed-fixed', from: 'learnFixed', to: 'fixed' },
    { id: 'learnFailed-gaveUp', from: 'learnFailed', to: 'gaveUp' },
    { id: 'learnUncertified-end', from: 'learnUncertified', to: 'uncertified' },
    ...hypotheses.edges,
    { id: 'rating-research', from: hypotheses.exit!, to: 'research' },
    { id: 'research-check', from: 'research', to: 'checkResearch' },
    { id: 'check-merge', from: 'checkResearch', to: 'mergeResearch' },
    { id: 'merge-diagnose', from: 'mergeResearch', to: 'diagnose' },
    { id: 'diagnose-challenge', from: 'diagnose', to: challenge.entry },
    ...challenge.edges,
    { id: 'approve-stability', from: 'approve', to: stability.control.entry, branch: 'approved' },
    ...stability.control.edges,
    {
      id: 'reproduce-tests',
      from: 'reproduceFirstOn',
      to: 'planReproduce',
      branch: 'then',
      label: 'tests first',
    },
    { id: 'planReproduce-tests', from: 'planReproduce', to: reproduce.entry },
    { id: 'reproduce-apply', from: 'reproduceFirstOn', to: edit.entry, branch: 'else' },
    { id: 'reproduced-check', from: 'reproduced', to: TESTS_KEPT_CHECK, branch: 'then' },
    { id: 'reproduced-review', from: 'reproduced', to: 'prReview', branch: 'else' },
    ...reproduce.edges,
    { id: 'approve-rejected', from: 'approve', to: 'rejected', branch: 'rejected' },
    ...edit.edges,
    ...stability.gate.edges,
    ...prReview.edges,
  ],
  demo: {
    context: { issue: 'Page 2 repeats the last item of page 1' },
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
            'H1: paginate slices from start - 1 | confirm if slice(start - 1, end) | refute if slice(start, end)',
            'H2: the caller passes a 0-based page | confirm if callers pass page - 1 | refute if callers pass 1-based pages',
            'H3: the data has duplicates (premise wrong) | confirm if the source repeats the item | refute if items are unique',
          ],
        },
        verdict: v('hypotheses proposed'),
      }),
      research: (s, visit) => ({
        updates: {
          newFindings:
            visit === 0
              ? [
                  'src/paginate.ts:7 — slice(start - 1, end) [H1 for]',
                  'src/list.ts:12 — callers pass 1-based pages [H2 against]',
                  'src/data.ts:3 — ids are unique [H3 against]',
                ]
              : [
                  `src/paginate.ts:9 — end is not clamped to items.length (${(s.gaps as string[]).join('; ')})`,
                ],
        },
        verdict: v('evidence gathered'),
      }),
      diagnose: (s) => ({
        updates: {
          rootCause:
            'src/paginate.ts:7 slices from start - 1, so each page starts one item early [F1]',
          files: ['src/paginate.ts', 'src/paginate.test.ts'],
          plan: '1. use slice(start, end)\n2. add a test for page boundaries',
          rulings: ((s.hypotheses as string[]) ?? []).map((h, i) =>
            i === 0
              ? `${h.split(':')[0]}: CONFIRMED — src/paginate.ts:7`
              : `${h.split(':')[0]}: REFUTED — ${i === 1 ? 'src/list.ts:12' : 'src/data.ts:3'}`,
          ),
          nondeterministic: false,
          flakyTarget: '',
          flakyFile: '',
          fixTarget: '',
        },
        verdict: v('root cause found'),
      }),
      challenge: () => ({ updates: { objections: [] }, verdict: v('the diagnosis stands') }),
      apply: (_s, visit) => ({
        updates: {
          changes:
            visit === 0
              ? ['src/paginate.ts: slice(start, end)']
              : [
                  'src/paginate.ts: clamp end to items.length',
                  'src/paginate.test.ts: boundary test',
                ],
        },
        verdict: v('edited'),
      }),
      triage: () => ({
        updates: {
          failureKind: 'PATCH',
          failureReason:
            'paginate.test.ts "last page": expected 10 items, got 9; end is not clamped',
        },
        verdict: v('the edit is incomplete'),
      }),
    },
    tools: {
      baseline: () => ({
        passed: false,
        output: 'FAIL src/paginate.test.ts > page 2 starts after page 1',
        command: 'npm test',
      }),
      snapshot: () => ({ diff: '', hash: 'base', files: [] }),
      recall: () => ({ facts: [], lessons: [] }),
      learnFixed: () => ({ saved: true }),
      learnFailed: () => ({ saved: true }),
      learnUncertified: () => ({ saved: true }),
      // The workspace as it is: unpatched before the first edit.
      controlSnapshot: (s) => ({ diff: '', hash: String(s.diffHash || 'base'), files: [] }),
      // With the gate (off in this demo): the flaky test fails once before the edit, never after.
      runControl: (s) => ({
        passed: false,
        output: `FAIL  ${String(s.flakyTarget)}`,
        command: String(s.controlCommand),
      }),
      runStable: (s) => ({
        passed: true,
        output: `✓ ${String(s.flakyTarget)} 2ms`,
        command: String(s.gateCommand),
      }),
      checkResearch: (s) => ({ valid: s.newFindings, invalid: [] }),
      captureDiff: (s) => {
        const n = (s.attempts as number) ?? 0;
        return {
          diff: `--- a/src/paginate.ts\n+++ b/src/paginate.ts\n@@ -7 +7 @@ attempt ${n + 1}`,
          hash: `diff-${n + 1}`,
          files: n === 0 ? ['src/paginate.ts'] : ['src/paginate.test.ts', 'src/paginate.ts'],
        };
      },
      runTests: (s) =>
        ((s.attempts as number) ?? 0) === 0
          ? {
              passed: false,
              output: 'FAIL paginate.test.ts > last page\nexpected 10 items, got 9',
              command: 'npm test',
            }
          : { passed: true, output: 'Tests 12 passed', command: 'npm test' },
    },
    approvals: { approve: () => ({ approved: true }) },
  },
};
