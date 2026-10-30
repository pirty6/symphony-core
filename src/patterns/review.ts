import { MAX_AGENTS, type Pattern } from '../core/types.js';
import {
  checkFindings,
  CITE_BY_ID,
  citesFindings,
  EVIDENCE_STATE,
  MERGE_FINDINGS,
} from './phases/evidence.js';

const v = (reason: string) => ({
  outcome: 'applied' as const,
  confidence: 0.9,
  shouldTerminate: false,
  reason,
});

/**
 * Read-only review of a branch or PR. The changed files are listed first, then
 * reviewed in parallel parts (as many sub-agents as the collector chose); every
 * finding cites the code and is checked before it counts. A review that found no
 * diff, or whose analysis failed, ends failed instead of "looks good".
 */
export const review: Pattern = {
  name: 'review',
  description: 'Review a branch or PR diff for bugs and risks; report only real issues.',
  verbTriggers: ['review', 'audit', 'check my changes'],
  requiredContext: ['target'],
  goalFrom: 'target',
  result: ['report', 'findings', 'unverified'],
  maxSteps: 200,
  state: [
    { name: 'target', type: 'string', description: 'Branch, commit range or PR to review' },
    { name: 'hint', type: 'string', description: 'Optional: what to focus on' },
    { name: 'diffSummary', type: 'string', description: 'What changed, per file' },
    { name: 'files', type: 'string[]', description: 'Changed files to review (paths)' },
    {
      name: 'agents',
      type: 'number',
      initial: 3,
      description: `Parallel reviewers (1 to ${MAX_AGENTS}), chosen from the size of the diff`,
    },
    { name: 'filesPerAgent', type: 'number', initial: 3 },
    { name: 'reviewed', type: 'string[]', description: 'Files whose changes were read' },
    {
      name: 'newFindings',
      type: 'string[]',
      description: 'Issues found now: "path:line — problem `quote`"',
    },
    { name: 'findings', type: 'string[]', description: 'Checked issues, numbered F1, F2…' },
    ...EVIDENCE_STATE,
    { name: 'report', type: 'string', description: 'The review, by severity' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'collect',
      kind: 'agent',
      role: 'assessor',
      label: 'Collect diff',
      directive: `Read the diff for \`target\` (e.g. git diff, or gh pr diff for a PR; use \`hint\` if set). List every changed source file in \`files\` (paths only, no lockfiles or generated files) and summarize what changed per file in \`diffSummary\`. Set \`agents\` to how many reviewers should read in parallel (1 to ${MAX_AGENTS}): 1 for a few small files, more for a large diff. If there is no diff, leave \`files\` empty and say why in \`diffSummary\`.`,
      reads: ['target', 'hint'],
      writes: ['diffSummary', 'files', 'agents'],
      retries: 2,
      checks: [
        {
          expr: `agents >= 1 && agents <= ${MAX_AGENTS}`,
          message: `Set agents to a whole number from 1 to ${MAX_AGENTS}.`,
        },
      ],
    },
    {
      id: 'hasDiff',
      kind: 'condition',
      label: 'Anything changed?',
      expression: 'len(files) > 0',
    },
    {
      id: 'analyze',
      kind: 'agent',
      role: 'assessor',
      label: 'Find issues',
      directive:
        'Review the changes to the files in `files` (yours only) for `target`: read each diff hunk and the code around it. Look for bugs, security problems and logic errors; ignore style. Write one issue per `newFindings` entry as "path:line — problem `exact quote of that line`", only for issues you can point to. List in `reviewed` every file of `files` you read. An empty `newFindings` is right when the changes are sound. If you could not read the changes at all, say so with verdict outcome "failed".',
      reads: ['target', 'hint', 'diffSummary', 'files'],
      writes: ['newFindings', 'reviewed'],
      cites: 'newFindings',
      fanOut: { over: 'files', per: 'filesPerAgent', agents: 'agents' },
      retries: 2,
      checks: [
        {
          expr: 'subset(files, reviewed)',
          message: 'Read every file in files; list each in reviewed.',
        },
      ],
    },
    {
      id: 'analyzed',
      kind: 'condition',
      label: 'Reviewed?',
      expression: 'verdict.outcome != "failed"',
    },
    checkFindings('checkReview'),
    { id: 'mergeReview', kind: 'compute', label: 'Record issues', assign: [...MERGE_FINDINGS] },
    { id: 'hasIssues', kind: 'condition', label: 'Issues?', expression: 'len(findings) > 0' },
    {
      id: 'report',
      kind: 'agent',
      role: 'assessor',
      label: 'Write report',
      directive: `Write a short review of \`target\` from \`findings\`, ordered by severity, with a suggested fix for each. ${CITE_BY_ID} End with the files reviewed.`,
      reads: ['target', 'findings', 'diffSummary', 'reviewed'],
      writes: ['report'],
      retries: 2,
      checks: [citesFindings('report')],
    },
    {
      id: 'cleanReport',
      kind: 'compute',
      label: 'Nothing found',
      assign: [
        {
          field: 'report',
          expr: '"No real issues found. Reviewed: " + join(reviewed, ", ")',
        },
      ],
    },
    { id: 'issues', kind: 'end', label: 'Issues reported', outcome: 'success' },
    { id: 'clean', kind: 'end', label: 'Looks good', outcome: 'success' },
    { id: 'noDiff', kind: 'end', label: 'No changes found', outcome: 'failed' },
    { id: 'notReviewed', kind: 'end', label: 'Could not review', outcome: 'failed' },
  ],
  edges: [
    { id: 'start-collect', from: 'start', to: 'collect' },
    { id: 'collect-hasDiff', from: 'collect', to: 'hasDiff' },
    { id: 'hasDiff-analyze', from: 'hasDiff', to: 'analyze', branch: 'then' },
    { id: 'hasDiff-noDiff', from: 'hasDiff', to: 'noDiff', branch: 'else' },
    { id: 'analyze-analyzed', from: 'analyze', to: 'analyzed' },
    { id: 'analyzed-check', from: 'analyzed', to: 'checkReview', branch: 'then' },
    { id: 'analyzed-not', from: 'analyzed', to: 'notReviewed', branch: 'else' },
    { id: 'check-merge', from: 'checkReview', to: 'mergeReview' },
    { id: 'merge-hasIssues', from: 'mergeReview', to: 'hasIssues' },
    { id: 'hasIssues-report', from: 'hasIssues', to: 'report', branch: 'then' },
    { id: 'hasIssues-clean', from: 'hasIssues', to: 'cleanReport', branch: 'else' },
    { id: 'report-issues', from: 'report', to: 'issues' },
    { id: 'cleanReport-clean', from: 'cleanReport', to: 'clean' },
  ],
  demo: {
    goal: 'Review the current branch',
    context: { target: 'HEAD~1..HEAD' },
    tools: {
      checkReview: (s) => ({ valid: s.newFindings, invalid: [] }),
    },
    agents: {
      collect: () => ({
        updates: {
          diffSummary: 'src/core/engine.ts: new retry logic',
          files: ['src/core/engine.ts'],
          agents: 1,
        },
        verdict: v('diff read'),
      }),
      analyze: (s) => ({
        updates: {
          newFindings: ['src/core/engine.ts:120 — retry counter never resets `attempts += 1`'],
          reviewed: (s.files as string[]) ?? [],
        },
        verdict: v('1 issue'),
      }),
      report: () => ({
        updates: { report: 'HIGH: the retry counter never resets [F1] (engine.ts:120).' },
        verdict: v('reported'),
      }),
    },
  },
};
