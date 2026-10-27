import type { Pattern } from '../core/types.js';

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

/** Diagnose (read-only) -> human approves plan -> apply + verify (write) with a bounded retry loop. */
export const fix: Pattern = {
  name: 'fix',
  description: 'Fix a bug: diagnose, get the plan approved, apply, run tests, retry up to 3 times.',
  verbTriggers: ['fix', 'bug', 'broken', 'repair'],
  requiredContext: ['issue'],
  state: [
    { name: 'issue', type: 'string', description: 'Bug description' },
    { name: 'rootCause', type: 'string' },
    { name: 'files', type: 'string[]', description: 'Files to change' },
    { name: 'plan', type: 'string' },
    { name: 'changes', type: 'string[]', description: 'Summary of edits applied' },
    { name: 'testsPassed', type: 'boolean' },
    { name: 'testOutput', type: 'string', description: 'Relevant test output' },
    { name: 'attempts', type: 'number' },
    { name: 'maxAttempts', type: 'number', initial: 3 },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'diagnose',
      kind: 'agent',
      role: 'assessor',
      label: 'Diagnose',
      directive:
        'Read the code (no edits) to find the root cause of `issue`. Return the root cause, the files to change and a short step-by-step plan.',
      reads: ['issue'],
      writes: ['rootCause', 'files', 'plan'],
    },
    {
      id: 'approve',
      kind: 'approval',
      label: 'Approve plan',
      message: 'Review the root cause and plan. Approve to let the executor edit files.',
      writes: [],
    },
    {
      id: 'apply',
      kind: 'agent',
      role: 'executor',
      label: 'Apply fix',
      directive:
        'Edit only `files` to implement `plan`. If `testOutput` is set, it is the failure from the last attempt: address it. Return a summary of each change.',
      reads: ['issue', 'rootCause', 'files', 'plan', 'testOutput'],
      writes: ['changes'],
      maxVisits: 3,
    },
    {
      id: 'verify',
      kind: 'agent',
      role: 'executor',
      label: 'Run tests',
      directive:
        "Run the project's test command (check package.json). Report whether tests passed and the relevant output (failures only, max 40 lines).",
      reads: ['changes'],
      writes: ['testsPassed', 'testOutput'],
      maxVisits: 3,
    },
    {
      id: 'count',
      kind: 'compute',
      label: 'Count attempt',
      assign: [{ field: 'attempts', expr: 'attempts + 1' }],
    },
    { id: 'passed', kind: 'condition', label: 'Tests pass?', expression: 'testsPassed' },
    { id: 'budget', kind: 'condition', label: 'Retry?', expression: 'attempts < maxAttempts' },
    { id: 'fixed', kind: 'end', label: 'Fixed', outcome: 'success' },
    { id: 'gaveUp', kind: 'end', label: 'Gave up', outcome: 'failed' },
    { id: 'rejected', kind: 'end', label: 'Plan rejected', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-diagnose', from: 'start', to: 'diagnose' },
    { id: 'diagnose-approve', from: 'diagnose', to: 'approve' },
    { id: 'approve-apply', from: 'approve', to: 'apply', branch: 'approved' },
    { id: 'approve-rejected', from: 'approve', to: 'rejected', branch: 'rejected' },
    { id: 'apply-verify', from: 'apply', to: 'verify' },
    { id: 'verify-count', from: 'verify', to: 'count' },
    { id: 'count-passed', from: 'count', to: 'passed' },
    { id: 'passed-fixed', from: 'passed', to: 'fixed', branch: 'then' },
    { id: 'passed-budget', from: 'passed', to: 'budget', branch: 'else' },
    { id: 'budget-apply', from: 'budget', to: 'apply', branch: 'then', label: 'retry' },
    { id: 'budget-gaveUp', from: 'budget', to: 'gaveUp', branch: 'else' },
  ],
  demo: {
    goal: 'Fix the off-by-one in pagination',
    context: { issue: 'Page 2 repeats the last item of page 1' },
    agents: {
      diagnose: () => ({
        updates: {
          rootCause: 'slice(start - 1, end) includes the previous item',
          files: ['src/paginate.ts'],
          plan: '1. use slice(start, end)\n2. add a test for page boundaries',
        },
        verdict: v('root cause found'),
      }),
      apply: (_s, visit) => ({
        updates: {
          changes:
            visit === 0
              ? ['src/paginate.ts: slice(start, end)']
              : ['src/paginate.ts: clamp end', 'test added'],
        },
        verdict: v('edited'),
      }),
      verify: (_s, visit) =>
        visit === 0
          ? {
              updates: { testsPassed: false, testOutput: 'expected 10 items, got 9' },
              verdict: v('tests failed', 0.8),
            }
          : { updates: { testsPassed: true, testOutput: '' }, verdict: v('tests pass') },
    },
    approvals: { approve: () => ({ approved: true }) },
  },
};
