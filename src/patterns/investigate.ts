import type { Pattern } from '../core/types.js';

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

const RELEVANT = /engine|schema|validate/;

/**
 * Thorough investigation. Coverage is owned by the engine, not the AI:
 *
 *   catalog + inventory (tools)   every source available, every file in the workspace
 *   plan                          AI splits the question and picks the best sources; every
 *                                 source must be used or explicitly skipped with a reason
 *   triage loop                   every file, in batches; an answer that leaves out a file is rejected
 *   deep-read loop                every relevant file read fully, following references and history
 *   source loop                   every chosen source searched (git history, GitHub, deps, web, MCP, ...)
 *   gap loop                      unanswered sub-questions get targeted research (bounded)
 *   answer                        cites evidence and reports coverage and what is still open
 */
export const investigate: Pattern = {
  name: 'investigate',
  description:
    'Answer a question exhaustively: triage every file, deep-read the relevant ones, search every useful source (history, GitHub, dependencies, web, MCP), close gaps, cite evidence.',
  verbTriggers: ['investigate', 'explain', 'why', 'how does', 'find out', 'research'],
  requiredContext: ['question'],
  maxSteps: 5000,
  state: [
    { name: 'question', type: 'string', description: 'What to find out' },
    { name: 'hint', type: 'string', description: 'Optional human clarification' },
    { name: 'sourceNames', type: 'string[]', description: 'Evidence sources available' },
    { name: 'sourceInfo', type: 'string[]', description: 'How to use each source' },
    { name: 'repoFiles', type: 'string[]', description: 'Every file in the workspace' },
    { name: 'excludedFiles', type: 'string[]', description: 'Files not triaged, with reasons' },
    { name: 'subQuestions', type: 'string[]', description: 'Parts of the question to answer' },
    { name: 'searchTerms', type: 'string[]', description: 'Queries for search-based sources' },
    { name: 'useSources', type: 'string[]', description: 'Sources to search' },
    { name: 'skipSources', type: 'string[]', description: 'Sources not searched' },
    { name: 'skipReasons', type: 'string[]', description: 'Why each skipped source was skipped' },
    { name: 'batchSize', type: 'number', initial: 25 },
    { name: 'pendingFiles', type: 'string[]' },
    { name: 'batch', type: 'string[]', description: 'Files to triage now' },
    { name: 'triaged', type: 'string[]', description: 'Files of the batch that were opened' },
    { name: 'batchRelevant', type: 'string[]', description: 'Relevant files of the batch' },
    { name: 'relevantFiles', type: 'string[]' },
    { name: 'deepBatchSize', type: 'number', initial: 4 },
    { name: 'pendingDeep', type: 'string[]' },
    { name: 'deepBatch', type: 'string[]', description: 'Files to read completely now' },
    { name: 'examined', type: 'string[]', description: 'Files of the deep batch read completely' },
    { name: 'pendingSources', type: 'string[]' },
    { name: 'currentSource', type: 'string', description: 'Source to search now' },
    { name: 'queries', type: 'string[]', description: 'Queries, commands and tool calls made' },
    { name: 'consulted', type: 'string[]', description: 'Sources searched, with what was asked' },
    { name: 'newFindings', type: 'string[]', description: 'Evidence found in this step' },
    { name: 'findings', type: 'string[]', description: 'All evidence, each with its location' },
    { name: 'gaps', type: 'string[]', description: 'Sub-questions without enough evidence' },
    { name: 'gapRounds', type: 'number' },
    { name: 'maxGapRounds', type: 'number', initial: 2 },
    { name: 'confidence', type: 'number', description: '0..1 that findings answer the question' },
    { name: 'answer', type: 'string', description: 'Final answer citing evidence' },
    { name: 'openQuestions', type: 'string[]', description: 'Sub-questions still unanswered' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'catalog',
      kind: 'tool',
      label: 'List sources',
      tool: 'sources.catalog',
      output: { names: 'sourceNames', descriptions: 'sourceInfo' },
    },
    {
      id: 'inventory',
      kind: 'tool',
      label: 'List every file',
      tool: 'repo.files',
      output: { files: 'repoFiles', excluded: 'excludedFiles' },
    },
    {
      id: 'plan',
      kind: 'agent',
      role: 'assessor',
      label: 'Plan research',
      directive:
        'Plan a thorough investigation of `question` (use `hint` if set). Split it into concrete sub-questions. Every workspace file will be triaged regardless of your plan; your job is to choose which ADDITIONAL sources from `sourceInfo` are the best fit. Prefer using a source over skipping it: skip only when it cannot plausibly hold relevant evidence, and say why. Write `searchTerms` as concrete queries for web, GitHub, history and MCP searches.',
      reads: ['question', 'hint', 'sourceNames', 'sourceInfo', 'excludedFiles'],
      writes: ['subQuestions', 'searchTerms', 'useSources', 'skipSources', 'skipReasons'],
      retries: 2,
      checks: [
        {
          expr: 'len(subQuestions) > 0',
          message: 'Break the question into at least one sub-question.',
        },
        {
          expr: 'subset(sourceNames, useSources + skipSources)',
          message:
            'Decide on EVERY source in sourceNames: put each in useSources or in skipSources.',
        },
        {
          expr: 'subset(useSources + skipSources, sourceNames)',
          message: 'Only use source names that appear in sourceNames.',
        },
        {
          expr: 'len(without(useSources, skipSources)) == len(useSources)',
          message: 'A source cannot be both used and skipped.',
        },
        {
          expr: 'len(skipReasons) == len(skipSources)',
          message:
            'Give exactly one reason in skipReasons per entry in skipSources, in the same order.',
        },
      ],
    },
    {
      id: 'queue',
      kind: 'compute',
      label: 'Queue work',
      assign: [
        { field: 'pendingFiles', expr: 'repoFiles' },
        { field: 'pendingSources', expr: 'unique(useSources)' },
      ],
    },
    {
      id: 'filesLeft',
      kind: 'condition',
      label: 'Files left?',
      expression: 'len(pendingFiles) > 0',
    },
    {
      id: 'takeBatch',
      kind: 'compute',
      label: 'Next batch',
      assign: [
        { field: 'batch', expr: 'take(pendingFiles, batchSize)' },
        { field: 'pendingFiles', expr: 'drop(pendingFiles, batchSize)' },
      ],
    },
    {
      id: 'triage',
      kind: 'agent',
      role: 'assessor',
      label: 'Triage files',
      directive:
        'Open EVERY file in `batch` (view each one; for long files look through all of it, not just the top). Decide whether it is relevant to the question or any sub-question; when unsure, count it as relevant. Put every path of `batch` in `triaged`, the relevant ones in `batchRelevant`, and any concrete evidence you saw in `newFindings` as "path:line — fact".',
      reads: ['question', 'subQuestions', 'batch'],
      writes: ['triaged', 'batchRelevant', 'newFindings'],
      retries: 2,
      checks: [
        {
          expr: 'subset(batch, triaged)',
          message: 'You skipped files. Open and list EVERY file of batch in triaged.',
        },
        { expr: 'subset(triaged, batch)', message: 'triaged may only contain files from batch.' },
        {
          expr: 'subset(batchRelevant, batch)',
          message: 'batchRelevant may only contain files from batch.',
        },
      ],
    },
    {
      id: 'mergeTriage',
      kind: 'compute',
      label: 'Record triage',
      assign: [
        { field: 'relevantFiles', expr: 'relevantFiles + batchRelevant' },
        { field: 'findings', expr: 'findings + newFindings' },
      ],
    },
    {
      id: 'deepQueue',
      kind: 'compute',
      label: 'Queue deep reads',
      assign: [{ field: 'pendingDeep', expr: 'unique(relevantFiles)' }],
    },
    {
      id: 'deepLeft',
      kind: 'condition',
      label: 'Deep reads left?',
      expression: 'len(pendingDeep) > 0',
    },
    {
      id: 'takeDeep',
      kind: 'compute',
      label: 'Next deep batch',
      assign: [
        { field: 'deepBatch', expr: 'take(pendingDeep, deepBatchSize)' },
        { field: 'pendingDeep', expr: 'drop(pendingDeep, deepBatchSize)' },
      ],
    },
    {
      id: 'deepRead',
      kind: 'agent',
      role: 'assessor',
      label: 'Deep read',
      directive:
        'Read every file in `deepBatch` completely, line by line. Follow references out of them: imports, callers, tests, config, and the history of the relevant lines (git log -p, git blame). Record every fact that bears on the question as "path:line — fact" in `newFindings`, without repeating `findings`. List each file of `deepBatch` you read completely in `examined`.',
      reads: ['question', 'subQuestions', 'deepBatch', 'findings'],
      writes: ['examined', 'newFindings'],
      retries: 2,
      checks: [
        {
          expr: 'subset(deepBatch, examined)',
          message: 'Read EVERY file of deepBatch completely and list it in examined.',
        },
      ],
    },
    {
      id: 'mergeDeep',
      kind: 'compute',
      label: 'Record deep read',
      assign: [{ field: 'findings', expr: 'findings + newFindings' }],
    },
    {
      id: 'sourcesLeft',
      kind: 'condition',
      label: 'Sources left?',
      expression: 'len(pendingSources) > 0',
    },
    {
      id: 'takeSource',
      kind: 'compute',
      label: 'Next source',
      assign: [
        { field: 'currentSource', expr: 'first(pendingSources)' },
        { field: 'pendingSources', expr: 'drop(pendingSources, 1)' },
      ],
    },
    {
      id: 'sweep',
      kind: 'agent',
      role: 'assessor',
      label: 'Search source',
      capabilities: ['web', 'mcp'],
      directive:
        'Search `currentSource` (see `sourceInfo` for how to use it) for evidence on every sub-question, using `searchTerms` and your own follow-up queries. Be exhaustive: look at several results, read full pages, threads, issues and diffs, and follow links. Record every query, command or tool call in `queries`, and every relevant fact as "source | location (URL, issue/PR #, commit, tool) — fact" in `newFindings`. If the source has nothing relevant, add one finding saying what you searched.',
      reads: ['question', 'subQuestions', 'searchTerms', 'currentSource', 'sourceInfo', 'findings'],
      writes: ['queries', 'newFindings'],
      retries: 2,
      checks: [
        {
          expr: 'len(queries) > 0',
          message: 'Record every query, command or tool call you made in queries.',
        },
        {
          expr: 'len(newFindings) > 0',
          message:
            'Report what you found, or one finding saying nothing relevant was found and where you looked.',
        },
      ],
    },
    {
      id: 'mergeSource',
      kind: 'compute',
      label: 'Record source',
      assign: [
        { field: 'findings', expr: 'findings + newFindings' },
        { field: 'consulted', expr: 'append(consulted, currentSource)' },
      ],
    },
    {
      id: 'assess',
      kind: 'agent',
      role: 'assessor',
      label: 'Find gaps',
      directive:
        'For EACH sub-question, decide whether `findings` answer it with concrete, cited evidence. Copy every sub-question that is not fully answered into `gaps` exactly as written. Set `confidence` (0..1) that the findings fully answer `question`.',
      reads: ['question', 'subQuestions', 'findings', 'skipSources', 'skipReasons'],
      writes: ['gaps', 'confidence'],
      retries: 2,
      checks: [
        {
          expr: 'subset(gaps, subQuestions)',
          message: 'gaps must be copied exactly from subQuestions.',
        },
      ],
    },
    {
      id: 'moreGaps',
      kind: 'condition',
      label: 'Chase gaps?',
      expression: 'len(gaps) > 0 && gapRounds < maxGapRounds',
    },
    {
      id: 'chase',
      kind: 'agent',
      role: 'assessor',
      label: 'Close gaps',
      capabilities: ['web', 'mcp'],
      directive:
        'Close every gap in `gaps` with targeted research, using ANY source in `sourceInfo` (including ones skipped before) and `hint` if set. Record every query, command or tool call in `queries` and every fact as "source | location — fact" in `newFindings`. If a gap has no evidence anywhere, add a finding saying where you looked.',
      reads: ['question', 'gaps', 'hint', 'findings', 'sourceInfo', 'consulted'],
      writes: ['queries', 'newFindings'],
      retries: 2,
      checks: [
        {
          expr: 'len(queries) > 0',
          message: 'Record every query, command or tool call you made in queries.',
        },
        {
          expr: 'len(newFindings) > 0',
          message:
            'Report a finding for every gap, even if it is where you looked without success.',
        },
      ],
    },
    {
      id: 'mergeChase',
      kind: 'compute',
      label: 'Record gap research',
      assign: [
        { field: 'findings', expr: 'findings + newFindings' },
        { field: 'gapRounds', expr: 'gapRounds + 1' },
      ],
    },
    {
      id: 'confident',
      kind: 'condition',
      label: 'Good enough?',
      expression: 'confidence >= 0.7 || !empty(hint)',
    },
    {
      id: 'clarify',
      kind: 'approval',
      label: 'Ask for a hint',
      message:
        'The investigation could not fully answer the question. Give a hint (where to look, what you mean) to research the gaps again, or reject to get the best answer with the gaps listed.',
      writes: ['hint'],
      maxVisits: 1,
    },
    {
      id: 'useHint',
      kind: 'compute',
      label: 'Use hint',
      assign: [
        { field: 'hint', expr: 'if(empty(hint), "(no hint given)", hint)' },
        { field: 'gapRounds', expr: '0' },
      ],
    },
    {
      id: 'answer',
      kind: 'agent',
      role: 'assessor',
      label: 'Write answer',
      directive:
        'Answer `question` using only `findings`, citing evidence inline (path:line, URL, issue/PR #, commit). End with a "Coverage" section: files triaged and excluded (`excludedFiles`), sources searched (`consulted`), sources skipped with their reasons, and what is still unknown. Put every unanswered sub-question in `openQuestions`.',
      reads: [
        'question',
        'subQuestions',
        'findings',
        'gaps',
        'consulted',
        'skipSources',
        'skipReasons',
        'excludedFiles',
        'confidence',
      ],
      writes: ['answer', 'openQuestions'],
      retries: 2,
      checks: [
        { expr: 'len(answer) > 0', message: 'Write the answer.' },
        {
          expr: 'subset(gaps, openQuestions)',
          message: 'Every remaining gap must be listed in openQuestions.',
        },
      ],
    },
    { id: 'done', kind: 'end', label: 'Answered' },
  ],
  edges: [
    { id: 'start-catalog', from: 'start', to: 'catalog' },
    { id: 'catalog-inventory', from: 'catalog', to: 'inventory' },
    { id: 'inventory-plan', from: 'inventory', to: 'plan' },
    { id: 'plan-queue', from: 'plan', to: 'queue' },
    { id: 'queue-filesLeft', from: 'queue', to: 'filesLeft' },
    { id: 'filesLeft-takeBatch', from: 'filesLeft', to: 'takeBatch', branch: 'then' },
    { id: 'filesLeft-deepQueue', from: 'filesLeft', to: 'deepQueue', branch: 'else' },
    { id: 'takeBatch-triage', from: 'takeBatch', to: 'triage' },
    { id: 'triage-mergeTriage', from: 'triage', to: 'mergeTriage' },
    { id: 'mergeTriage-filesLeft', from: 'mergeTriage', to: 'filesLeft', label: 'next batch' },
    { id: 'deepQueue-deepLeft', from: 'deepQueue', to: 'deepLeft' },
    { id: 'deepLeft-takeDeep', from: 'deepLeft', to: 'takeDeep', branch: 'then' },
    { id: 'deepLeft-sourcesLeft', from: 'deepLeft', to: 'sourcesLeft', branch: 'else' },
    { id: 'takeDeep-deepRead', from: 'takeDeep', to: 'deepRead' },
    { id: 'deepRead-mergeDeep', from: 'deepRead', to: 'mergeDeep' },
    { id: 'mergeDeep-deepLeft', from: 'mergeDeep', to: 'deepLeft', label: 'next file' },
    { id: 'sourcesLeft-takeSource', from: 'sourcesLeft', to: 'takeSource', branch: 'then' },
    { id: 'sourcesLeft-assess', from: 'sourcesLeft', to: 'assess', branch: 'else' },
    { id: 'takeSource-sweep', from: 'takeSource', to: 'sweep' },
    { id: 'sweep-mergeSource', from: 'sweep', to: 'mergeSource' },
    { id: 'mergeSource-sourcesLeft', from: 'mergeSource', to: 'sourcesLeft', label: 'next source' },
    { id: 'assess-moreGaps', from: 'assess', to: 'moreGaps' },
    { id: 'moreGaps-chase', from: 'moreGaps', to: 'chase', branch: 'then' },
    { id: 'moreGaps-confident', from: 'moreGaps', to: 'confident', branch: 'else' },
    { id: 'chase-mergeChase', from: 'chase', to: 'mergeChase' },
    { id: 'mergeChase-assess', from: 'mergeChase', to: 'assess', label: 're-assess' },
    { id: 'confident-answer', from: 'confident', to: 'answer', branch: 'then' },
    { id: 'confident-clarify', from: 'confident', to: 'clarify', branch: 'else' },
    { id: 'clarify-useHint', from: 'clarify', to: 'useHint', branch: 'approved' },
    { id: 'clarify-answer', from: 'clarify', to: 'answer', branch: 'rejected' },
    { id: 'useHint-chase', from: 'useHint', to: 'chase' },
    { id: 'answer-done', from: 'answer', to: 'done' },
  ],
  demo: {
    goal: 'Find where AI answers are validated',
    context: { question: 'Where are AI responses validated before they change state, and why?' },
    tools: {
      catalog: () => ({
        names: ['git-history', 'web', 'prior-runs'],
        descriptions: [
          'git-history: commit history and blame',
          'web: web_search(query) and web_fetch(url)',
          'prior-runs: earlier Symphony runs',
        ],
      }),
      inventory: () => ({
        files: [
          'README.md',
          'src/core/engine.ts',
          'src/core/schema.ts',
          'src/core/validate.ts',
          'src/cli.ts',
        ],
        excluded: ['logo.png — binary file'],
      }),
    },
    agents: {
      plan: (s) => {
        const names = (s.sourceNames as string[]) ?? [];
        const skip = names.filter((n) => n === 'prior-runs' || n.startsWith('mcp:'));
        return {
          updates: {
            subQuestions: [
              'Which function validates AI answers?',
              'Why is validation done before state changes?',
            ],
            searchTerms: ['validateNodeResult', 'deterministic state machine validation'],
            useSources: names.filter((n) => !skip.includes(n)),
            skipSources: skip,
            skipReasons: skip.map((n) => `${n} is unlikely to explain this code`),
          },
          verdict: v('planned'),
        };
      },
      triage: (s) => {
        const batch = (s.batch as string[]) ?? [];
        const relevant = batch.filter((f) => RELEVANT.test(f));
        return {
          updates: {
            triaged: batch,
            batchRelevant: relevant,
            newFindings: relevant.map((f) => `${f}:1 — mentions validation`),
          },
          verdict: v(`triaged ${batch.length} files`),
        };
      },
      deepRead: (s) => {
        const batch = (s.deepBatch as string[]) ?? [];
        return {
          updates: {
            examined: batch,
            newFindings: batch.map((f) =>
              f.endsWith('schema.ts')
                ? `${f}:115 — validateNodeResult checks verdict and typed updates`
                : `${f}:1 — reviewed fully`,
            ),
          },
          verdict: v('read fully'),
        };
      },
      sweep: (s) => ({
        updates: {
          queries: [
            `${String(s.currentSource)}: ${((s.searchTerms as string[]) ?? [])[0] ?? 'question'}`,
          ],
          newFindings: [
            `${String(s.currentSource)} | search — consistent with validate-before-apply design`,
          ],
        },
        verdict: v('searched'),
      }),
      assess: (s, visit) =>
        visit === 0
          ? {
              updates: {
                gaps: [((s.subQuestions as string[]) ?? [])[1] ?? ''].filter(Boolean),
                confidence: 0.6,
              },
              verdict: v('one gap', 0.6),
            }
          : { updates: { gaps: [], confidence: 0.9 }, verdict: v('covered') },
      chase: () => ({
        updates: {
          queries: ['git log -S validateNodeResult'],
          newFindings: [
            'git-history | commit "feat(core): score/performance types and response validation" — validation added with the engine',
          ],
        },
        verdict: v('gap closed'),
      }),
      answer: (s) => ({
        updates: {
          answer:
            'validateNodeResult in src/core/schema.ts:115, called by resolveAgent in src/core/engine.ts, rejects malformed answers before state changes so runs stay deterministic.',
          openQuestions: (s.gaps as string[]) ?? [],
        },
        verdict: v('answered'),
      }),
    },
    approvals: {
      clarify: () => ({ approved: true, updates: { hint: 'look at src/core/schema.ts' } }),
    },
  },
};
