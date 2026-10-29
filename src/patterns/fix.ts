import type { Pattern } from '../core/types.js';
import { challengePhase, hypothesesPhase, withState } from './phases/debate.js';
import { editVerifyPhase } from './phases/editVerify.js';
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

const hypotheses = hypothesesPhase({
  subject: 'issue',
  context: ['hint', 'knownFacts', 'pastLessons'],
});
const challenge = challengePhase({
  subject: 'issue',
  evidence: 'findings',
  draft: 'rootCause',
  gaps: 'gaps',
  reopen: 'research',
  done: 'approve',
  research: ['hint', 'gaps'],
});
const edit = editVerifyPhase({
  applyDirective:
    'Implement `plan` by editing `files` (others only if the plan truly needs them). Fix the root cause in `rootCause`, not the symptom, and add or update a test that fails without the fix when that is feasible.',
  applyReads: ['issue', 'rootCause', 'files', 'plan'],
  triageReads: ['issue', 'rootCause', 'plan'],
  success: 'learnFixed',
  giveUp: 'learnFailed',
  rediagnose: { node: 'research', gaps: 'gaps' },
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
    'rootCause',
    'plan',
    'changedFiles',
    'testsPassed',
    'failureKind',
    'failureReason',
    'rulings',
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
      ...EVIDENCE_STATE,
      ...MEMORY_STATE,
    ],
    hypotheses,
    challenge,
    edit,
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
    edit.group,
  ],
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    recallMemory('recall', 'issue'),
    ...hypotheses.nodes,
    {
      id: 'research',
      kind: 'agent',
      role: 'assessor',
      capabilities: ['web'],
      label: 'Gather evidence',
      directive:
        'Read the code (no edits) for evidence on `issue`: for AND against every entry of `hypotheses`, tagging each finding with the hypotheses it bears on (e.g. "[H2 against]"). Find the code path that produces the symptom, the tests that cover it, and recent changes to it (git log -p, git blame). If `gaps` is set, settle those first: they are objections to the last diagnosis or the reason the last fix failed. Record each fact in `newFindings`, without repeating `findings`.' +
        MEMORY_NOTE,
      reads: ['issue', 'hint', 'hypotheses', 'findings', 'gaps', 'knownFacts'],
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
        ' Rule on every hypothesis in `rulings`, in order: "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence". List the files to change in `files` and a short step-by-step `plan` that fixes the cause (not the symptom) and adds a test. If a previous fix failed (`failureReason`, `testOutput`), the new plan must explain why it will not fail the same way.',
      reads: ['issue', 'hint', 'hypotheses', 'findings', 'failureReason', 'testOutput'],
      writes: ['rootCause', 'files', 'plan', 'rulings'],
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
    ...edit.nodes,
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
    { id: 'fixed', kind: 'end', label: 'Fixed', outcome: 'success' },
    { id: 'gaveUp', kind: 'end', label: 'Gave up', outcome: 'failed' },
    { id: 'rejected', kind: 'end', label: 'Plan rejected', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-recall', from: 'start', to: 'recall' },
    { id: 'recall-hypothesize', from: 'recall', to: hypotheses.entry },
    { id: 'learnFixed-fixed', from: 'learnFixed', to: 'fixed' },
    { id: 'learnFailed-gaveUp', from: 'learnFailed', to: 'gaveUp' },
    ...hypotheses.edges,
    { id: 'rating-research', from: hypotheses.exit!, to: 'research' },
    { id: 'research-check', from: 'research', to: 'checkResearch' },
    { id: 'check-merge', from: 'checkResearch', to: 'mergeResearch' },
    { id: 'merge-diagnose', from: 'mergeResearch', to: 'diagnose' },
    { id: 'diagnose-challenge', from: 'diagnose', to: challenge.entry },
    ...challenge.edges,
    { id: 'approve-apply', from: 'approve', to: edit.entry, branch: 'approved' },
    { id: 'approve-rejected', from: 'approve', to: 'rejected', branch: 'rejected' },
    ...edit.edges,
  ],
  demo: {
    context: { issue: 'Page 2 repeats the last item of page 1' },
    agents: {
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
      recall: () => ({ facts: [], lessons: [] }),
      learnFixed: () => ({ saved: true }),
      learnFailed: () => ({ saved: true }),
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
