import type { Pattern } from '../core/types.js';

const v = (reason: string, confidence = 0.85) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

const DEMO_ANALYSES = [
  'Monthly revenue trend by region',
  'Churn rate by plan tier',
  'Outliers in order value',
];

/**
 * Exploratory analysis, built for jazz. The `muse` node is a solo point:
 *   classical/cool  play the written melody: `maxAnalyses` analyses, then conclude
 *   swing and up    the AI decides after each analysis whether to dig further or conclude
 *   bebop/free      the muse also plays 2-3 takes that a bandleader merges (more ideas)
 * Every analysis runs as code (an executor writing scratch scripts), so the numbers
 * are reproducible even when the route was improvised.
 */
export const analyze: Pattern = {
  name: 'analyze',
  description:
    'Explore a dataset to answer a question: profile it, run analyses one at a time (the AI improvises which ones in jazz), then conclude with caveats.',
  verbTriggers: [
    'analyze',
    'analyse',
    'analytics',
    'data',
    'dataset',
    'explore',
    'trend',
    'metrics',
  ],
  requiredContext: ['question', 'data'],
  goalFrom: 'question',
  improvisation: 2,
  maxSteps: 200,
  state: [
    { name: 'question', type: 'string', description: 'What to learn from the data' },
    { name: 'data', type: 'string', description: 'Path, table or description of the data' },
    { name: 'profile', type: 'string', description: 'Shape, columns, types, gaps, basic stats' },
    { name: 'findings', type: 'string[]', description: 'Every result so far, with numbers' },
    { name: 'newFindings', type: 'string[]' },
    { name: 'nextAnalysis', type: 'string', description: 'The analysis to run next' },
    { name: 'rationale', type: 'string', description: 'Why that analysis, or why stop' },
    { name: 'analyses', type: 'string[]', description: 'Analyses run so far' },
    { name: 'maxAnalyses', type: 'number', initial: 4 },
    { name: 'result', type: 'string', description: 'Output of the latest analysis' },
    { name: 'conclusion', type: 'string' },
    { name: 'caveats', type: 'string[]' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'profile',
      kind: 'agent',
      role: 'executor',
      label: 'Profile the data',
      directive:
        'Load `data` with a short script (Python, SQL or the shell, whatever fits) and profile it: row count, columns and types, missing values, ranges, obvious data-quality issues. Never modify the source data; write scratch files only under .symphony/scratch/. Put the profile in `profile` and notable facts, each with numbers, in `newFindings`.',
      reads: ['question', 'data'],
      writes: ['profile', 'newFindings'],
    },
    {
      id: 'mergeProfile',
      kind: 'compute',
      label: 'Record profile',
      assign: [{ field: 'findings', expr: 'findings + newFindings' }],
    },
    {
      id: 'budget',
      kind: 'condition',
      label: 'Analyses left?',
      expression: 'len(analyses) < maxAnalyses',
    },
    {
      id: 'muse',
      kind: 'agent',
      role: 'assessor',
      solo: true,
      maxVisits: 12,
      label: 'Decide next move',
      directive:
        'Given the `question`, the `profile` and the `findings` so far, decide the single most informative analysis to run next and write it as a concrete, runnable instruction in `nextAnalysis` (what to compute, grouped by what, filtered how). Do not repeat anything in `analyses`. Explain the choice in `rationale`.',
      reads: ['question', 'profile', 'findings', 'analyses'],
      writes: ['nextAnalysis', 'rationale'],
    },
    {
      id: 'analyze',
      kind: 'agent',
      role: 'executor',
      maxVisits: 12,
      label: 'Run analysis',
      directive:
        'Run `nextAnalysis` against `data` with a script under .symphony/scratch/ (never modify the source data). Put the key output (tables or numbers, trimmed) in `result` and each insight, with its numbers, in `newFindings`.',
      reads: ['data', 'profile', 'nextAnalysis'],
      writes: ['result', 'newFindings'],
    },
    {
      id: 'record',
      kind: 'compute',
      label: 'Record analysis',
      assign: [
        { field: 'analyses', expr: 'append(analyses, nextAnalysis)' },
        { field: 'findings', expr: 'findings + newFindings' },
      ],
    },
    {
      id: 'conclude',
      kind: 'agent',
      role: 'assessor',
      label: 'Conclude',
      directive:
        'Answer `question` from `findings` only, citing the numbers. List in `caveats` the data-quality issues, assumptions and open questions that limit the conclusion.',
      reads: ['question', 'profile', 'findings', 'analyses'],
      writes: ['conclusion', 'caveats'],
    },
    { id: 'done', kind: 'end', label: 'Concluded', outcome: 'success' },
  ],
  edges: [
    { id: 'start-profile', from: 'start', to: 'profile' },
    { id: 'profile-merge', from: 'profile', to: 'mergeProfile' },
    { id: 'merge-budget', from: 'mergeProfile', to: 'budget' },
    { id: 'budget-muse', from: 'budget', to: 'muse', branch: 'then' },
    {
      id: 'budget-conclude',
      from: 'budget',
      to: 'conclude',
      branch: 'else',
      label: 'budget spent',
    },
    { id: 'dig', from: 'muse', to: 'analyze', label: 'run this analysis' },
    { id: 'wrap', from: 'muse', to: 'conclude', label: 'enough evidence: conclude' },
    { id: 'analyze-record', from: 'analyze', to: 'record' },
    { id: 'record-budget', from: 'record', to: 'budget', label: 'next' },
    { id: 'conclude-done', from: 'conclude', to: 'done' },
  ],
  demo: {
    context: { question: 'What drives revenue changes this quarter?', data: 'sales.csv (demo)' },
    agents: {
      profile: () => ({
        updates: {
          profile: '12,480 rows; columns date, region, plan, revenue, churned; 0.4% missing region',
          newFindings: ['Revenue is 61% from the EU region', '0.4% of rows have no region'],
        },
        verdict: v('profiled'),
      }),
      muse: (s) => {
        const done = (s.analyses as string[]) ?? [];
        const next = DEMO_ANALYSES.find((a) => !done.includes(a)) ?? 'Revenue by weekday';
        return {
          updates: { nextAnalysis: next, rationale: `Next most informative cut: ${next}` },
          verdict: v('chose next move'),
          next: done.length >= 2 ? 'wrap' : 'dig',
        };
      },
      analyze: (s) => ({
        updates: {
          result: `${String(s.nextAnalysis)}: computed`,
          newFindings: [`${String(s.nextAnalysis)}: EU down 8% month over month`],
        },
        verdict: v('analysis run'),
      }),
      conclude: () => ({
        updates: {
          conclusion:
            'Revenue fell because EU enterprise churn rose 3 points; other regions were flat.',
          caveats: ['0.4% of rows lack a region', 'One quarter of data; no seasonality check'],
        },
        verdict: v('concluded'),
      }),
    },
  },
};
