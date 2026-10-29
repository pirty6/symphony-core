import type { Pattern } from '../core/types.js';
import { challengePhase, hypothesesPhase, withState } from './phases/debate.js';
import {
  checkFindings,
  CITE_BY_ID,
  citesFindings,
  EVIDENCE_STATE,
  MEMORY_STATE,
  MERGE_FINDINGS,
  recallMemory,
} from './phases/evidence.js';

const hypotheses = hypothesesPhase({
  subject: 'question',
  context: ['hint', 'subQuestions', 'sourceInfo', 'knownFacts', 'pastLessons'],
});
const challenge = challengePhase({
  subject: 'question',
  evidence: 'findings',
  draft: 'answer',
  gaps: 'gaps',
  reopen: 'chase',
  done: 'done',
  research: ['subQuestions', 'sourceInfo', 'useSources', 'hint'],
});

const AGAINST =
  ' Look for evidence for AND against every entry of `hypotheses`, and tag each finding with the hypotheses it bears on, e.g. "[H2 against]".';

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

const RELEVANT = /engine|schema|validate/;

/**
 * Thorough investigation that adapts its evidence to the question. The engine
 * owns every work queue; the planner only decides which kinds of evidence apply:
 *
 *   Plan research    list the evidence sources available; the AI splits the question and
 *                    decides, with a reason for every skip, which sources it needs
 *   List evidence    only what the plan needs: every workspace file (repo questions), the web
 *                    pages worth reading (internet questions), experiments to run (behaviour
 *                    or performance questions)
 *   Triage files     every listed file, in batches; an answer that skips a file is rejected
 *   Deep read        every relevant file and every listed page, read completely
 *   Run experiments  after your approval, each experiment is run and measured
 *   Search sources   history, GitHub, dependencies, MCP: each chosen source searched
 *   Close gaps       unanswered sub-questions get targeted research, then a human hint
 *   Answer           cited, with a coverage report
 */
export const investigate: Pattern = {
  name: 'investigate',
  description:
    'Answer a question exhaustively with the evidence it needs: repo files, web pages, experiments, history, GitHub, dependencies, MCP. Nothing listed is skipped; every claim is cited.',
  verbTriggers: ['investigate', 'explain', 'why', 'how does', 'find out', 'research'],
  requiredContext: ['question'],
  result: ['answer', 'rulings', 'openQuestions', 'disagreements', 'unresolvedObjections'],
  goalFrom: 'question',
  maxSteps: 5000,
  state: withState(
    [
      { name: 'question', type: 'string', description: 'What to find out' },
      { name: 'hint', type: 'string', description: 'Optional human clarification' },
      { name: 'sourceNames', type: 'string[]', description: 'Evidence sources available' },
      { name: 'sourceInfo', type: 'string[]', description: 'How to use each source' },
      { name: 'subQuestions', type: 'string[]', description: 'Parts of the question to answer' },
      { name: 'searchTerms', type: 'string[]', description: 'Queries for search-based sources' },
      { name: 'useSources', type: 'string[]', description: 'Sources to use' },
      { name: 'skipSources', type: 'string[]', description: 'Sources not used' },
      { name: 'skipReasons', type: 'string[]', description: 'Why each skipped source was skipped' },
      { name: 'repoFiles', type: 'string[]', description: 'Every file in the workspace' },
      { name: 'excludedFiles', type: 'string[]', description: 'Files not triaged, with reasons' },
      { name: 'pages', type: 'string[]', description: 'Web pages to read in full (URLs)' },
      {
        name: 'experiments',
        type: 'string[]',
        description: 'Experiments to run: command, what it measures',
      },
      { name: 'batchSize', type: 'number', initial: 25 },
      {
        name: 'batchWave',
        type: 'number',
        initial: 75,
        description: 'Files per triage round, split into parallel calls of batchSize',
      },
      { name: 'pendingFiles', type: 'string[]' },
      { name: 'batch', type: 'string[]', description: 'Files to triage now' },
      { name: 'triaged', type: 'string[]', description: 'Files of the batch that were opened' },
      { name: 'batchRelevant', type: 'string[]', description: 'Relevant files of the batch' },
      { name: 'relevantFiles', type: 'string[]' },
      { name: 'deepBatchSize', type: 'number', initial: 4 },
      {
        name: 'deepWave',
        type: 'number',
        initial: 12,
        description: 'Items per deep-read round, split into parallel calls of deepBatchSize',
      },
      { name: 'pendingDeep', type: 'string[]' },
      {
        name: 'deepBatch',
        type: 'string[]',
        description: 'Files and pages to read completely now',
      },
      {
        name: 'examined',
        type: 'string[]',
        description: 'Items of the deep batch read completely',
      },
      {
        name: 'unreadable',
        type: 'string[]',
        description: 'Items of the deep batch that could not be read in full',
      },
      {
        name: 'unreadableReasons',
        type: 'string[]',
        description: 'Why, per unreadable item, and how much was read',
      },
      {
        name: 'notRead',
        type: 'string[]',
        description: 'Every item that could not be read in full',
      },
      { name: 'notReadReasons', type: 'string[]', description: 'Why, per notRead item' },
      { name: 'unreadRetries', type: 'number' },
      {
        name: 'maxUnreadRetries',
        type: 'number',
        initial: 1,
        description: 'Extra tries for items that could not be read (rate limits, timeouts)',
      },
      { name: 'pendingExperiments', type: 'string[]' },
      { name: 'currentExperiment', type: 'string', description: 'Experiment to run now' },
      { name: 'ran', type: 'string[]', description: 'Experiments run' },
      { name: 'pendingSources', type: 'string[]' },
      { name: 'currentSource', type: 'string', description: 'Source to search now' },
      { name: 'queries', type: 'string[]', description: 'Queries, commands and tool calls made' },
      { name: 'consulted', type: 'string[]', description: 'Sources searched' },
      { name: 'newFindings', type: 'string[]', description: 'Evidence found in this step' },
      {
        name: 'findings',
        type: 'string[]',
        description: 'All checked evidence, each with its id (F<n>) and location',
      },
      ...EVIDENCE_STATE,
      ...MEMORY_STATE,
      { name: 'gaps', type: 'string[]', description: 'Sub-questions without enough evidence' },
      { name: 'gapRounds', type: 'number' },
      { name: 'maxGapRounds', type: 'number', initial: 2 },
      { name: 'confidence', type: 'number', description: '0..1 that findings answer the question' },
      { name: 'answer', type: 'string', description: 'Final answer citing evidence' },
      { name: 'openQuestions', type: 'string[]', description: 'Sub-questions still unanswered' },
    ],
    hypotheses,
    challenge,
  ),
  start: 'start',
  groups: [
    {
      id: 'planPhase',
      label: 'Plan research',
      description: 'Available sources, sub-questions, which evidence applies',
      nodes: ['catalog', 'plan', 'queue'],
    },
    hypotheses.group,
    {
      id: 'listPhase',
      label: 'List evidence',
      description: 'Only what the plan needs: workspace files, web pages, experiments',
      nodes: [
        'needFiles',
        'inventory',
        'queueFiles',
        'needWeb',
        'listPages',
        'needExperiments',
        'designExperiments',
      ],
    },
    {
      id: 'triagePhase',
      label: 'Triage files',
      description: 'Every listed file, in batches',
      nodes: ['filesLeft', 'takeBatch', 'triage', 'checkTriage', 'mergeTriage'],
    },
    {
      id: 'deepPhase',
      label: 'Deep read',
      description: 'Every relevant file and listed page, completely',
      nodes: [
        'deepQueue',
        'deepLeft',
        'takeDeep',
        'deepRead',
        'checkDeep',
        'mergeDeep',
        'retryUnread',
        'requeueUnread',
      ],
    },
    {
      id: 'experimentPhase',
      label: 'Run experiments',
      description: 'With your approval, run and measure',
      nodes: [
        'hasExperiments',
        'allowExperiments',
        'queueExperiments',
        'experimentsLeft',
        'takeExperiment',
        'experiment',
        'checkExperiment',
        'mergeExperiment',
      ],
    },
    {
      id: 'sourcePhase',
      label: 'Search sources',
      description: 'History, GitHub, dependencies, MCP',
      nodes: ['sourcesLeft', 'takeSource', 'sweep', 'checkSource', 'mergeSource'],
    },
    {
      id: 'gapPhase',
      label: 'Close gaps',
      description: 'Targeted research, then a human hint',
      nodes: [
        'assess',
        'moreGaps',
        'chase',
        'checkChase',
        'mergeChase',
        'confident',
        'clarify',
        'useHint',
      ],
    },
    challenge.group,
  ],
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    recallMemory('recall', 'question'),
    {
      id: 'catalog',
      kind: 'tool',
      label: 'List sources',
      tool: 'sources.catalog',
      output: { names: 'sourceNames', descriptions: 'sourceInfo' },
    },
    {
      id: 'plan',
      kind: 'agent',
      role: 'assessor',
      label: 'Plan research',
      directive:
        'Plan a thorough investigation of `question` (use `hint` if set). Split it into concrete sub-questions. Then decide, for EVERY source in `sourceInfo`, whether it can hold evidence for this question: put it in `useSources` or in `skipSources` with one reason per skip in `skipReasons`. Match the evidence to the question: questions about this codebase need `workspace`; questions about the outside world (libraries, standards, other projects) need `web`; questions about behaviour or performance (does it work, why is it slow, which is faster) need `experiment` to reproduce or measure; why-questions about code usually need `git-history`. Prefer using a source over skipping it. Write `searchTerms` as concrete queries for web, GitHub, history and MCP searches.',
      reads: ['question', 'hint', 'sourceNames', 'sourceInfo'],
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
        { expr: 'len(useSources) > 0', message: 'Use at least one source.' },
      ],
    },
    {
      id: 'queue',
      kind: 'compute',
      label: 'Queue sources',
      assign: [
        {
          field: 'pendingSources',
          expr: 'without(unique(useSources), ["workspace", "web", "experiment"])',
        },
      ],
    },
    {
      id: 'needFiles',
      kind: 'condition',
      label: 'Workspace?',
      expression: 'includes(useSources, "workspace")',
    },
    {
      id: 'inventory',
      kind: 'tool',
      label: 'List every file',
      tool: 'repo.files',
      output: { files: 'repoFiles', excluded: 'excludedFiles' },
    },
    {
      id: 'queueFiles',
      kind: 'compute',
      label: 'Queue files',
      assign: [{ field: 'pendingFiles', expr: 'repoFiles' }],
    },
    { id: 'needWeb', kind: 'condition', label: 'Web?', expression: 'includes(useSources, "web")' },
    {
      id: 'listPages',
      kind: 'agent',
      role: 'assessor',
      capabilities: ['web'],
      label: 'List web pages',
      directive:
        'For EVERY sub-question, search the web with several queries (start from `searchTerms`) and list the pages worth reading in full: official documentation, changelogs, issue and discussion threads, benchmarks, papers. Look past the first results. Put one URL per entry in `pages`, most authoritative first (at most 15). Record every query in `queries`.',
      reads: ['question', 'subQuestions', 'searchTerms'],
      writes: ['pages', 'queries'],
      retries: 2,
      checks: [
        {
          expr: 'len(pages) > 0',
          message: 'List at least one page to read, or explain in queries what you searched.',
        },
        { expr: 'len(queries) > 0', message: 'Record every query you made in queries.' },
      ],
    },
    {
      id: 'needExperiments',
      kind: 'condition',
      label: 'Experiments?',
      expression: 'includes(useSources, "experiment")',
    },
    {
      id: 'designExperiments',
      kind: 'agent',
      role: 'assessor',
      label: 'Design experiments',
      directive:
        'Design the experiments that would answer the behaviour or performance parts of `question`: each entry of `experiments` is one experiment as "command(s) to run — what it measures or reproduces — how to read the result". Make them fair and repeatable (same inputs, warm-up, at least 3 timed repetitions for performance). Never anything that edits tracked files, installs globally, or needs secrets.',
      reads: ['question', 'subQuestions', 'sourceInfo'],
      writes: ['experiments'],
      retries: 2,
      checks: [{ expr: 'len(experiments) > 0', message: 'Design at least one experiment.' }],
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
        { field: 'batch', expr: 'take(pendingFiles, batchWave)' },
        { field: 'pendingFiles', expr: 'drop(pendingFiles, batchWave)' },
      ],
    },
    {
      id: 'triage',
      kind: 'agent',
      role: 'assessor',
      label: 'Triage files',
      directive:
        'Open EVERY file in `batch` (view each one; for long files look through all of it, not just the top). Decide whether it is relevant to the question or any sub-question; when unsure, count it as relevant. Put every path of `batch` in `triaged`, the relevant ones in `batchRelevant`, and any concrete evidence you saw in `newFindings` as "path:line — fact".' +
        AGAINST,
      reads: ['hypotheses', 'question', 'subQuestions', 'batch'],
      fanOut: { over: 'batch', per: 'batchSize' },
      writes: ['triaged', 'batchRelevant', 'newFindings'],
      cites: 'newFindings',
      retries: 2,
      complexityShift: -1,
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
    checkFindings('checkTriage'),
    {
      id: 'mergeTriage',
      kind: 'compute',
      label: 'Record triage',
      assign: [
        { field: 'relevantFiles', expr: 'relevantFiles + batchRelevant' },
        ...MERGE_FINDINGS,
      ],
    },
    {
      id: 'deepQueue',
      kind: 'compute',
      label: 'Queue deep reads',
      assign: [{ field: 'pendingDeep', expr: 'unique(relevantFiles + pages)' }],
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
        { field: 'deepBatch', expr: 'take(pendingDeep, deepWave)' },
        { field: 'pendingDeep', expr: 'drop(pendingDeep, deepWave)' },
      ],
    },
    {
      id: 'deepRead',
      kind: 'agent',
      role: 'assessor',
      capabilities: ['web'],
      label: 'Deep read',
      directive:
        'Read every item of `deepBatch` completely. Workspace files: line by line, following references out of them (imports, callers, tests, config) and the history of the relevant lines (git log -p, git blame). Web pages (URLs): fetch and read the whole page, following links that matter. Record every fact that bears on the question as "path:line — fact" or "URL — fact" in `newFindings`. List each item of `deepBatch` you read completely in `examined`. If an item cannot be read in full (HTTP errors, rate limits, truncated or paywalled pages, unreadable files), do not pretend (items you could not read before come back once for another try): put it in `unreadable` and, at the same position, say why and how much you did read in `unreadableReasons`.' +
        AGAINST,
      reads: ['hypotheses', 'question', 'subQuestions', 'deepBatch'],
      fanOut: { over: 'deepBatch', per: 'deepBatchSize' },
      writes: ['examined', 'newFindings', 'unreadable', 'unreadableReasons'],
      cites: 'newFindings',
      retries: 2,
      checks: [
        {
          expr: 'subset(deepBatch, examined + unreadable)',
          message:
            'Account for EVERY item of deepBatch: read it completely and list it in examined, or list it in unreadable with a reason.',
        },
        {
          expr: 'subset(unreadable, deepBatch)',
          message: 'unreadable may only list items of deepBatch.',
        },
        {
          expr: 'len(unreadableReasons) == len(unreadable)',
          message:
            'Give one reason in unreadableReasons per item in unreadable, in the same order.',
        },
      ],
    },
    {
      id: 'retryUnread',
      kind: 'condition',
      label: 'Retry unreadable?',
      // Rate limits and timeouts often clear by the end of deep reading: one more try, then report.
      expression: 'len(notRead) > 0 && unreadRetries < maxUnreadRetries',
    },
    {
      id: 'requeueUnread',
      kind: 'compute',
      label: 'Queue unreadable again',
      assign: [
        { field: 'pendingDeep', expr: 'notRead' },
        { field: 'notRead', expr: '[]' },
        { field: 'notReadReasons', expr: '[]' },
        { field: 'unreadRetries', expr: 'unreadRetries + 1' },
      ],
    },
    checkFindings('checkDeep'),
    {
      id: 'mergeDeep',
      kind: 'compute',
      label: 'Record deep read',
      assign: [
        ...MERGE_FINDINGS,
        { field: 'notRead', expr: 'notRead + unreadable' },
        { field: 'notReadReasons', expr: 'notReadReasons + unreadableReasons' },
        { field: 'unreadable', expr: '[]' },
        { field: 'unreadableReasons', expr: '[]' },
      ],
    },
    {
      id: 'hasExperiments',
      kind: 'condition',
      label: 'Experiments listed?',
      expression: 'len(experiments) > 0',
    },
    {
      id: 'allowExperiments',
      kind: 'approval',
      label: 'Allow experiments?',
      message:
        'These experiments run commands in your workspace (scratch files only). Approve to run them, or reject to skip them.',
      writes: [],
      shows: ['experiments'],
    },
    {
      id: 'queueExperiments',
      kind: 'compute',
      label: 'Queue experiments',
      assign: [{ field: 'pendingExperiments', expr: 'experiments' }],
    },
    {
      id: 'experimentsLeft',
      kind: 'condition',
      label: 'Experiments left?',
      expression: 'len(pendingExperiments) > 0',
    },
    {
      id: 'takeExperiment',
      kind: 'compute',
      label: 'Next experiment',
      assign: [
        { field: 'currentExperiment', expr: 'first(pendingExperiments)' },
        { field: 'pendingExperiments', expr: 'drop(pendingExperiments, 1)' },
      ],
    },
    {
      id: 'experiment',
      kind: 'agent',
      role: 'executor',
      maxVisits: 20,
      label: 'Run experiment',
      directive:
        'Run `currentExperiment` in the workspace. Do not modify tracked files: put any scripts and output only in the scratch folder named in your instructions. For timings, warm up once and report the median of at least 3 runs with the raw numbers. Record every command you ran in `queries` and each result, with its numbers and the command, in `newFindings`. If it cannot run, say exactly why in `newFindings`.',
      reads: ['question', 'currentExperiment'],
      writes: ['queries', 'newFindings'],
      cites: 'newFindings',
      retries: 1,
      checks: [
        { expr: 'len(queries) > 0', message: 'Record the commands you ran in queries.' },
        {
          expr: 'len(newFindings) > 0',
          message: 'Report the results (or why the experiment could not run) in newFindings.',
        },
      ],
    },
    checkFindings('checkExperiment'),
    {
      id: 'mergeExperiment',
      kind: 'compute',
      label: 'Record experiment',
      assign: [...MERGE_FINDINGS, { field: 'ran', expr: 'append(ran, currentExperiment)' }],
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
        'Search `currentSource` (see `sourceInfo` for how to use it) for evidence on every sub-question, using `searchTerms` and your own follow-up queries. Be exhaustive: look at several results, read full pages, threads, issues and diffs, and follow links. Record every query, command or tool call in `queries`, and every relevant fact as "source | location (URL, issue/PR #, commit, tool) — fact" in `newFindings`. If the source has nothing relevant, add one finding saying what you searched.' +
        AGAINST,
      reads: [
        'hypotheses',
        'question',
        'subQuestions',
        'searchTerms',
        'currentSource',
        'sourceInfo',
      ],
      writes: ['queries', 'newFindings'],
      cites: 'newFindings',
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
    checkFindings('checkSource'),
    {
      id: 'mergeSource',
      kind: 'compute',
      label: 'Record source',
      assign: [...MERGE_FINDINGS, { field: 'consulted', expr: 'append(consulted, currentSource)' }],
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
        'Close every gap in `gaps` with targeted research, using ANY source in `sourceInfo` (including ones skipped before) and `hint` if set. Record every query, command or tool call in `queries` and every fact as "source | location — fact" in `newFindings`. If a gap has no evidence anywhere, add a finding saying where you looked.' +
        AGAINST,
      reads: ['hypotheses', 'question', 'gaps', 'hint', 'findings', 'sourceInfo', 'consulted'],
      writes: ['queries', 'newFindings'],
      cites: 'newFindings',
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
    checkFindings('checkChase'),
    {
      id: 'mergeChase',
      kind: 'compute',
      label: 'Record gap research',
      assign: [...MERGE_FINDINGS, { field: 'gapRounds', expr: 'gapRounds + 1' }],
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
        'Answer `question` using only `findings`. ' +
        CITE_BY_ID +
        ' Findings the engine could not verify are in `unverified`: do not rely on them. End with a "Coverage" section: files triaged and excluded (`excludedFiles`), pages read (`pages`), experiments run (`ran`), items that could not be read in full and why (`notRead`, `notReadReasons`), sources searched (`consulted`), sources skipped with their reasons, and what is still unknown. Put anything still unknown in `openQuestions`, in your own words (remaining `gaps` are added for you). In `rulings`, give one entry per hypothesis, in order: "H<n>: CONFIRMED | REFUTED | UNKNOWN — the evidence"; never confirm one without evidence for it or refute one without evidence against it. If the answer was challenged, address the objections it answered.',
      reads: [
        'question',
        'subQuestions',
        'findings',
        'gaps',
        'consulted',
        'skipSources',
        'skipReasons',
        'excludedFiles',
        'pages',
        'ran',
        'notRead',
        'notReadReasons',
        'confidence',
        'hypotheses',
        'disagreements',
        'unverified',
      ],
      writes: ['answer', 'openQuestions', 'rulings'],
      verifyBelow: 0.6,
      retries: 2,
      complexityShift: 1,
      checks: [
        { expr: 'len(answer) > 0', message: 'Write the answer.' },
        citesFindings('answer'),
        {
          expr: 'len(rulings) == len(hypotheses)',
          message:
            'Give exactly one ruling per hypothesis: "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence".',
        },
      ],
    },
    {
      id: 'listOpen',
      kind: 'compute',
      label: 'List open questions',
      // The engine, not the AI, guarantees every remaining gap is reported verbatim.
      assign: [{ field: 'openQuestions', expr: 'unique(gaps + openQuestions)' }],
    },
    ...hypotheses.nodes,
    ...challenge.nodes,
    { id: 'done', kind: 'end', label: 'Answered' },
  ],
  edges: [
    { id: 'start-recall', from: 'start', to: 'recall' },
    { id: 'recall-catalog', from: 'recall', to: 'catalog' },
    { id: 'catalog-plan', from: 'catalog', to: 'plan' },
    { id: 'plan-queue', from: 'plan', to: 'queue' },
    { id: 'queue-hypothesize', from: 'queue', to: hypotheses.entry },
    ...hypotheses.edges,
    { id: 'rating-needFiles', from: hypotheses.exit!, to: 'needFiles' },
    { id: 'needFiles-inventory', from: 'needFiles', to: 'inventory', branch: 'then' },
    { id: 'needFiles-needWeb', from: 'needFiles', to: 'needWeb', branch: 'else' },
    { id: 'inventory-queueFiles', from: 'inventory', to: 'queueFiles' },
    { id: 'queueFiles-needWeb', from: 'queueFiles', to: 'needWeb' },
    { id: 'needWeb-listPages', from: 'needWeb', to: 'listPages', branch: 'then' },
    { id: 'needWeb-needExperiments', from: 'needWeb', to: 'needExperiments', branch: 'else' },
    { id: 'listPages-needExperiments', from: 'listPages', to: 'needExperiments' },
    {
      id: 'needExperiments-design',
      from: 'needExperiments',
      to: 'designExperiments',
      branch: 'then',
    },
    { id: 'needExperiments-filesLeft', from: 'needExperiments', to: 'filesLeft', branch: 'else' },
    { id: 'design-filesLeft', from: 'designExperiments', to: 'filesLeft' },
    { id: 'filesLeft-takeBatch', from: 'filesLeft', to: 'takeBatch', branch: 'then' },
    { id: 'filesLeft-deepQueue', from: 'filesLeft', to: 'deepQueue', branch: 'else' },
    { id: 'takeBatch-triage', from: 'takeBatch', to: 'triage' },
    { id: 'triage-checkTriage', from: 'triage', to: 'checkTriage' },
    { id: 'checkTriage-mergeTriage', from: 'checkTriage', to: 'mergeTriage' },
    { id: 'mergeTriage-filesLeft', from: 'mergeTriage', to: 'filesLeft', label: 'next batch' },
    { id: 'deepQueue-deepLeft', from: 'deepQueue', to: 'deepLeft' },
    { id: 'deepLeft-takeDeep', from: 'deepLeft', to: 'takeDeep', branch: 'then' },
    { id: 'deepLeft-retryUnread', from: 'deepLeft', to: 'retryUnread', branch: 'else' },
    {
      id: 'retryUnread-requeue',
      from: 'retryUnread',
      to: 'requeueUnread',
      branch: 'then',
      label: 'try unreadable again',
    },
    { id: 'retryUnread-hasExperiments', from: 'retryUnread', to: 'hasExperiments', branch: 'else' },
    { id: 'requeue-deepLeft', from: 'requeueUnread', to: 'deepLeft' },
    { id: 'takeDeep-deepRead', from: 'takeDeep', to: 'deepRead' },
    { id: 'deepRead-checkDeep', from: 'deepRead', to: 'checkDeep' },
    { id: 'checkDeep-mergeDeep', from: 'checkDeep', to: 'mergeDeep' },
    { id: 'mergeDeep-deepLeft', from: 'mergeDeep', to: 'deepLeft', label: 'next' },
    { id: 'hasExperiments-allow', from: 'hasExperiments', to: 'allowExperiments', branch: 'then' },
    { id: 'hasExperiments-sourcesLeft', from: 'hasExperiments', to: 'sourcesLeft', branch: 'else' },
    {
      id: 'allow-queueExperiments',
      from: 'allowExperiments',
      to: 'queueExperiments',
      branch: 'approved',
    },
    {
      id: 'allow-sourcesLeft',
      from: 'allowExperiments',
      to: 'sourcesLeft',
      branch: 'rejected',
      label: 'skipped',
    },
    { id: 'queueExperiments-left', from: 'queueExperiments', to: 'experimentsLeft' },
    { id: 'experimentsLeft-take', from: 'experimentsLeft', to: 'takeExperiment', branch: 'then' },
    {
      id: 'experimentsLeft-sourcesLeft',
      from: 'experimentsLeft',
      to: 'sourcesLeft',
      branch: 'else',
    },
    { id: 'takeExperiment-experiment', from: 'takeExperiment', to: 'experiment' },
    { id: 'experiment-checkExperiment', from: 'experiment', to: 'checkExperiment' },
    { id: 'checkExperiment-mergeExperiment', from: 'checkExperiment', to: 'mergeExperiment' },
    { id: 'mergeExperiment-left', from: 'mergeExperiment', to: 'experimentsLeft', label: 'next' },
    { id: 'sourcesLeft-takeSource', from: 'sourcesLeft', to: 'takeSource', branch: 'then' },
    { id: 'sourcesLeft-assess', from: 'sourcesLeft', to: 'assess', branch: 'else' },
    { id: 'takeSource-sweep', from: 'takeSource', to: 'sweep' },
    { id: 'sweep-checkSource', from: 'sweep', to: 'checkSource' },
    { id: 'checkSource-mergeSource', from: 'checkSource', to: 'mergeSource' },
    { id: 'mergeSource-sourcesLeft', from: 'mergeSource', to: 'sourcesLeft', label: 'next source' },
    { id: 'assess-moreGaps', from: 'assess', to: 'moreGaps' },
    { id: 'moreGaps-chase', from: 'moreGaps', to: 'chase', branch: 'then' },
    { id: 'moreGaps-confident', from: 'moreGaps', to: 'confident', branch: 'else' },
    { id: 'chase-checkChase', from: 'chase', to: 'checkChase' },
    { id: 'checkChase-mergeChase', from: 'checkChase', to: 'mergeChase' },
    { id: 'mergeChase-assess', from: 'mergeChase', to: 'assess', label: 're-assess' },
    { id: 'confident-answer', from: 'confident', to: 'answer', branch: 'then' },
    { id: 'confident-clarify', from: 'confident', to: 'clarify', branch: 'else' },
    { id: 'clarify-useHint', from: 'clarify', to: 'useHint', branch: 'approved' },
    { id: 'clarify-answer', from: 'clarify', to: 'answer', branch: 'rejected' },
    { id: 'useHint-chase', from: 'useHint', to: 'chase' },
    { id: 'answer-listOpen', from: 'answer', to: 'listOpen' },
    { id: 'listOpen-challenge', from: 'listOpen', to: challenge.entry },
    ...challenge.edges,
  ],
  demo: {
    context: { question: 'Where are AI responses validated before they change state, and why?' },
    tools: {
      recall: () => ({ facts: [], lessons: [] }),
      ...Object.fromEntries(
        ['checkTriage', 'checkDeep', 'checkExperiment', 'checkSource', 'checkChase'].map((id) => [
          id,
          (s: Readonly<Record<string, unknown>>) => ({ valid: s.newFindings, invalid: [] }),
        ]),
      ),
      catalog: () => ({
        names: ['workspace', 'git-history', 'web', 'experiment', 'prior-runs'],
        descriptions: [
          'workspace: 5 files in this workspace',
          'git-history: commit history and blame',
          'web: web_search(query) and web_fetch(url)',
          'experiment: run commands to reproduce or measure',
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
        const skip = names.filter(
          (n) => n === 'prior-runs' || n === 'experiment' || n.startsWith('mcp:'),
        );
        return {
          updates: {
            subQuestions: [
              'Which function validates AI answers?',
              'Why is validation done before state changes?',
            ],
            searchTerms: ['validateNodeResult', 'deterministic state machine validation'],
            useSources: names.filter((n) => !skip.includes(n)),
            skipSources: skip,
            skipReasons: skip.map((n) => `${n} cannot explain where code validates answers`),
          },
          verdict: v('planned'),
        };
      },
      listPages: () => ({
        updates: {
          pages: ['https://en.wikipedia.org/wiki/Finite-state_machine'],
          queries: ['web_search: validate before state transition'],
        },
        verdict: v('pages listed'),
      }),
      designExperiments: () => ({
        updates: {
          experiments: [
            'npm test -- src/core/engine.test.ts — does an invalid answer change state? — expect 0 changes',
          ],
        },
        verdict: v('designed'),
      }),
      experiment: (s) => ({
        updates: {
          queries: [String(s.currentExperiment).split(' — ')[0] ?? 'npm test'],
          newFindings: ['experiment | npm test — 0 state changes after an invalid answer (3 runs)'],
        },
        verdict: v('ran'),
      }),
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
            unreadable: [],
            unreadableReasons: [],
            newFindings: batch.map((f) =>
              f.startsWith('http')
                ? `${f} — state machines apply transitions only on valid input`
                : f.endsWith('schema.ts')
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
          answer: [
            "**AI answers are validated in the engine, before any state changes.** `resolveAgent` in `src/core/engine.ts` calls `checkAgentResult` (`src/core/schema.ts`), which checks the shape of `{ updates, verdict }`, that every key is one the node may write, and the solo route; then the node's acceptance checks run on the merged state [F1].",
            '',
            '## Why',
            '',
            '1. **Determinism**: `advance()` is pure, so a rejected answer leaves the state hash unchanged and a retry gets the same move key.',
            '2. **Auditability**: each rejected attempt is recorded with its errors in the Performance, so a replay reproduces the failure too.',
            '3. **Safety**: an assessor can never write keys it was not given (`updates.x is not writable here`).',
            '',
            '## Coverage',
            '',
            `- Files triaged: ${((s.triaged as string[]) ?? []).length}; read completely: ${((s.examined as string[]) ?? []).length}`,
            `- Web pages read: ${((s.pages as string[]) ?? []).length}; experiments run: ${((s.ran as string[]) ?? []).length}`,
            `- Sources searched: ${((s.consulted as string[]) ?? []).join(', ') || 'none'}; skipped: ${((s.skipSources as string[]) ?? []).join(', ') || 'none'}`,
          ].join('\n'),
          openQuestions: (s.gaps as string[]) ?? [],
          rulings: ((s.hypotheses as string[]) ?? []).map((h, i) =>
            i === 0
              ? `${h.split(':')[0]}: CONFIRMED — src/core/engine.ts resolveAgent validates before applying`
              : `${h.split(':')[0]}: REFUTED — no state change happens outside advance()`,
          ),
        },
        verdict: v('answered'),
      }),
      hypothesize: () => ({
        updates: {
          ratedComplexity: 2,
          hypotheses: [
            'H1: the engine validates every answer before state changes | confirm if advance() checks results before applying them | refute if a provider writes state directly',
            'H2: each provider validates its own answers | confirm if validation lives in src/runtime | refute if providers return raw results',
            'H3: answers are not validated at all (premise wrong) | confirm if results are applied unchecked | refute if any schema check runs',
          ],
        },
        verdict: v('hypotheses proposed'),
      }),
      challenge: (_s, visit) => ({
        updates: {
          objections:
            visit === 0
              ? [
                  'The answer says a rejected answer keeps the same move key, but no finding cites it: check moveKeyOf in src/core/engine.ts',
                ]
              : [],
        },
        verdict: v(visit === 0 ? 'one unsupported claim' : 'the answer stands'),
      }),
      triageObjections: (s) => ({
        updates: {
          objectionTriage: ((s.objections as string[]) ?? []).map(
            (o) => `${o.slice(0, 40)}…: REAL — it is a claim in the answer`,
          ),
          realObjections: (s.objections as string[]) ?? [],
        },
        verdict: v('triaged'),
      }),
      second: () => ({
        updates: {
          secondOpinion:
            'The engine validates (src/core/engine.ts resolveAgent → checkAgentResult). H1 confirmed; H2 and H3 refuted.',
        },
        verdict: v('independent answer'),
      }),
      reconcile: (s) => ({
        updates: {
          answer: s.answer,
          rulings: s.rulings,
          disagreements: [],
        },
        verdict: v('reconciled'),
      }),
    },
    approvals: {
      allowExperiments: () => ({ approved: true }),
      clarify: () => ({ approved: true, updates: { hint: 'look at src/core/schema.ts' } }),
    },
  },
};
