import type { Pattern } from '../core/types.js';
import { withState } from './phases/debate.js';
import { editVerifyPhase } from './phases/editVerify.js';

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

const edit = editVerifyPhase({
  applyDirective:
    'Restructure `files` as `plan` says WITHOUT changing behaviour: every entry of `invariants` must still hold, public APIs keep their names and signatures unless the plan says otherwise, and tests are not weakened. If you notice a bug, do NOT fix it here (that would change behaviour): list it in `noticedBugs` as "path:line — bug" for a separate fix.',
  applyReads: ['target', 'files', 'plan', 'invariants'],
  applyWrites: ['noticedBugs'],
  triageReads: ['target', 'plan', 'invariants'],
  success: 'refactored',
  giveUp: 'gaveUp',
});

/**
 * Refactor = a green test baseline + a behaviour-preserving plan you approve +
 * the shared edit-and-verify phase. The tests are the oracle: they passed
 * before, so they must pass after; bugs found on the way are reported, not fixed.
 */
export const refactor: Pattern = {
  name: 'refactor',
  description:
    'Restructure code without changing behaviour: tests must pass before and after; bugs found on the way are reported, not fixed.',
  verbTriggers: ['refactor', 'restructure', 'clean up', 'simplify', 'extract', 'rename', 'tidy'],
  requiredContext: ['target'],
  goalFrom: 'target',
  result: [
    'plan',
    'invariants',
    'changedFiles',
    'testsPassed',
    'noticedBugs',
    'failureKind',
    'failureReason',
  ],
  maxSteps: 200,
  state: withState(
    [
      {
        name: 'target',
        type: 'string',
        description: 'What to restructure and why (e.g. "split cli.ts into one file per command")',
      },
      { name: 'hint', type: 'string', description: 'Optional constraints or preferences' },
      { name: 'baselinePassed', type: 'boolean' },
      { name: 'baselineOutput', type: 'string', description: 'Tests before any edit' },
      { name: 'files', type: 'string[]', description: 'Files to restructure' },
      { name: 'plan', type: 'string', description: 'Step-by-step refactoring plan' },
      {
        name: 'invariants',
        type: 'string[]',
        description: 'Behaviour that must not change, and the tests that prove it',
      },
      {
        name: 'noticedBugs',
        type: 'string[]',
        description: 'Bugs seen while refactoring, left for a separate fix',
      },
    ],
    edit,
  ),
  start: 'start',
  groups: [
    {
      id: 'baselinePhase',
      label: 'Green baseline',
      description: 'Tests must pass before anything changes',
      nodes: ['baseline', 'green', 'snapshot'],
    },
    {
      id: 'planPhase',
      label: 'Plan',
      description: 'Files, steps and the behaviour that must not change',
      nodes: ['plan', 'approve'],
    },
    edit.group,
  ],
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'baseline',
      kind: 'tool',
      label: 'Run tests first',
      tool: 'tests.run',
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
    {
      id: 'plan',
      kind: 'agent',
      role: 'assessor',
      label: 'Plan refactoring',
      directive:
        'Read the code (no edits) and plan `target` as a behaviour-preserving refactoring. List the `files` to change and a step-by-step `plan` in small, safe steps. In `invariants`, list the behaviour that must not change and the tests that prove each one; if a behaviour has no test, say so and plan a characterisation test before restructuring it. Do not plan bug fixes or new features: note suspected bugs in `noticedBugs` instead.',
      reads: ['target', 'hint', 'baselineOutput'],
      writes: ['files', 'plan', 'invariants', 'noticedBugs'],
      retries: 2,
      complexityShift: 1,
      checks: [
        { expr: 'len(files) > 0', message: 'List the files to change.' },
        { expr: 'len(plan) > 0', message: 'Write the plan.' },
        {
          expr: 'len(invariants) > 0',
          message: 'List the behaviour that must not change and the tests that prove it.',
        },
      ],
    },
    {
      id: 'approve',
      kind: 'approval',
      label: 'Approve plan',
      message:
        'Review the plan and the behaviour it promises to keep. Approve to let the executor edit; the engine reruns the tests after every edit.',
      writes: [],
      shows: ['files', 'plan', 'invariants', 'noticedBugs'],
    },
    ...edit.nodes,
    { id: 'refactored', kind: 'end', label: 'Refactored', outcome: 'success' },
    { id: 'gaveUp', kind: 'end', label: 'Gave up', outcome: 'failed' },
    { id: 'notGreen', kind: 'end', label: 'Tests failing before', outcome: 'failed' },
    { id: 'rejected', kind: 'end', label: 'Plan rejected', outcome: 'partial' },
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
    { id: 'snapshot-plan', from: 'snapshot', to: 'plan' },
    { id: 'plan-approve', from: 'plan', to: 'approve' },
    { id: 'approve-apply', from: 'approve', to: edit.entry, branch: 'approved' },
    { id: 'approve-rejected', from: 'approve', to: 'rejected', branch: 'rejected' },
    ...edit.edges,
  ],
  demo: {
    context: { target: 'Extract the page-boundary arithmetic in src/paginate.ts into pageRange()' },
    agents: {
      plan: () => ({
        updates: {
          files: ['src/paginate.ts'],
          plan: '1. extract pageRange(page, size) returning [start, end]\n2. use it in paginate()',
          invariants: [
            'paginate(items, page, size) returns the same slice: src/paginate.test.ts',
            'pages past the end return []: src/paginate.test.ts "past the end"',
          ],
          noticedBugs: [],
        },
        verdict: v('planned'),
      }),
      apply: () => ({
        updates: {
          changes: ['src/paginate.ts: extract pageRange()', 'src/paginate.ts: paginate() uses it'],
          noticedBugs: ['src/paginate.ts:12 — negative page sizes are not rejected'],
        },
        verdict: v('restructured'),
      }),
      triage: () => ({
        updates: { failureKind: 'PATCH', failureReason: 'the extraction changed a result' },
        verdict: v('triaged'),
      }),
    },
    tools: {
      baseline: () => ({ passed: true, output: 'Tests 12 passed', command: 'npm test' }),
      snapshot: () => ({ diff: '', hash: 'base', files: [] }),
      captureDiff: () => ({
        diff: '--- a/src/paginate.ts\n+++ b/src/paginate.ts\n+function pageRange(',
        hash: 'refactor-1',
        files: ['src/paginate.ts'],
      }),
      runTests: () => ({ passed: true, output: 'Tests 12 passed', command: 'npm test' }),
    },
    approvals: { approve: () => ({ approved: true }) },
  },
};
