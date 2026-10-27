import type { Pattern } from '../core/types.js';

const v = (reason: string) => ({
  outcome: 'applied' as const,
  confidence: 0.9,
  shouldTerminate: false,
  reason,
});

/** Read-only review of a branch or PR. Every node is an assessor. */
export const review: Pattern = {
  name: 'review',
  description: 'Review a branch or PR diff for bugs and risks; report only real issues.',
  verbTriggers: ['review', 'audit', 'check my changes'],
  requiredContext: ['target'],
  state: [
    { name: 'target', type: 'string', description: 'Branch, commit range or PR to review' },
    { name: 'diffSummary', type: 'string' },
    { name: 'findings', type: 'string[]', description: 'One issue per entry: file:line - problem' },
    { name: 'report', type: 'string' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'collect',
      kind: 'agent',
      role: 'assessor',
      label: 'Collect diff',
      directive: 'Read the diff for `target` (e.g. git diff). Summarize what changed per file.',
      reads: ['target'],
      writes: ['diffSummary'],
    },
    {
      id: 'analyze',
      kind: 'agent',
      role: 'assessor',
      label: 'Find issues',
      directive:
        'Look for bugs, security problems and logic errors in the changes. Ignore style. Return one finding per entry as `file:line - problem`. Return an empty list if there are none.',
      reads: ['target', 'diffSummary'],
      writes: ['findings'],
    },
    { id: 'hasIssues', kind: 'condition', label: 'Issues?', expression: 'len(findings) > 0' },
    {
      id: 'report',
      kind: 'agent',
      role: 'assessor',
      label: 'Write report',
      directive: 'Write a short review report ordered by severity from `findings`.',
      reads: ['findings', 'diffSummary'],
      writes: ['report'],
    },
    { id: 'issues', kind: 'end', label: 'Issues reported', outcome: 'success' },
    { id: 'clean', kind: 'end', label: 'Looks good', outcome: 'success' },
  ],
  edges: [
    { id: 'start-collect', from: 'start', to: 'collect' },
    { id: 'collect-analyze', from: 'collect', to: 'analyze' },
    { id: 'analyze-hasIssues', from: 'analyze', to: 'hasIssues' },
    { id: 'hasIssues-report', from: 'hasIssues', to: 'report', branch: 'then' },
    { id: 'hasIssues-clean', from: 'hasIssues', to: 'clean', branch: 'else' },
    { id: 'report-issues', from: 'report', to: 'issues' },
  ],
  demo: {
    goal: 'Review the current branch',
    context: { target: 'HEAD~1..HEAD' },
    agents: {
      collect: () => ({
        updates: { diffSummary: 'engine.ts: new retry logic' },
        verdict: v('diff read'),
      }),
      analyze: () => ({
        updates: { findings: ['src/core/engine.ts:120 - retry counter never resets'] },
        verdict: v('1 issue'),
      }),
      report: () => ({
        updates: { report: 'HIGH: retry counter never resets (engine.ts:120)' },
        verdict: v('reported'),
      }),
    },
  },
};
