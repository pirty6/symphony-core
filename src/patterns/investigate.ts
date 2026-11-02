import { itemOf } from '../core/items.js';
import { MAX_AGENTS, type Pattern, type ScoreNode } from '../core/types.js';
import { challengePhase, hypothesesPhase, withState } from './phases/debate.js';
import {
  checkFindings,
  CITE_BY_ID,
  citesFindings,
  EVIDENCE_STATE,
  MEMORY_STATE,
  MERGE_FINDINGS,
  recallMemory,
  rememberCitedNode,
  rememberLessonNode,
} from './phases/evidence.js';

const hypotheses = hypothesesPhase({
  subject: 'question',
  context: ['hint', 'subQuestions', 'sourceInfo', 'knownFacts', 'pastLessons'],
});
const challenge = challengePhase({
  subject: 'question',
  // The debaters read findings without their (already checked) quotes.
  evidence: 'findingsBrief',
  draft: 'answer',
  gaps: 'gaps',
  // Through the gap check, so the run-wide research budget holds for objections too.
  reopen: 'moreGaps',
  done: 'attachParts',
  research: ['subQuestions', 'sourceInfo', 'useSources', 'hint'],
  // The skeptic sees what was asked, what could not be read and what did not check out.
  alongside: [
    'partAnswers',
    'subQuestions',
    'notRead',
    'unverified',
    'hypothesisStatus',
    'objectionResolutions',
  ],
  // A debate round gets its own gap-research budget instead of the one already spent.
  resetOnReopen: 'gapRounds',
  // Each objection names the sub-question it bears on.
  about: 'subQuestions',
  rememberChecked: false,
});

/** Most independent parts one investigation answers side by side. */
export const MAX_PARTS = 8;

/** The S tag of each entry ("S2"). */
const TAGS = (field: string) => `heads(${field}, "^S[0-9]+")`;

/** The entries of a "S<n>: …" list that say OPEN. */
const OPEN_ENTRIES = (field: string) =>
  `without(${field}, unmatched(${field}, "^S[0-9]+: OPEN([^A-Za-z]|$)"))`;

/** Lists the coverage report shows; long ones end with a pointer to the full field. */
const listed = (field: string, none: string) =>
  `if(len(${field}) == 0, "${none}", join(take(${field}, 15), "; ") + if(len(${field}) > 15, " … (all in ${field})", ""))`;

/** The coverage section, written by the engine from what it recorded (not by the AI). */
/** A finding citing a workspace file ("src/a.ts:3"), the kind evidence.check verifies. */
const FILE_CITE = '[A-Za-z0-9_@.-]+[.][A-Za-z0-9]+:[0-9]';

const COVERAGE = [
  '"## Coverage\n\n- Files not triaged: "',
  listed('excludedFiles', 'none'),
  '"\n- Not located, so not triaged: "',
  listed('unlocatedFiles', 'none'),
  // Only where it narrowed something: above maxTriageFiles, Locate decides (unlocatedFiles).
  'if(narrowRead && len(narrowedOut) > 0, "\n- Left unread by the narrowed read (opt-in): " + ' +
    listed('narrowedOut', 'none') +
    ', "")',
  '"\n- Pages read: "',
  listed('pages', 'none'),
  '"\n- Experiments run: "',
  listed('ran', 'none'),
  '"\n- Read because a gap named them: "',
  listed('expandedFiles', 'none'),
  '"\n- Could not read in full: "',
  listed('notRead', 'nothing'),
  '"\n- Sources searched: "',
  listed('consulted', 'none'),
  '"\n- Sources skipped: "',
  listed('skipReasons', 'none'),
  // Only path:line findings are checked against the files; the rest (web, other sources) are taken on trust.
  '"\n- Findings not checked against a file (web pages, other sources): "',
  `text(len(findings) - count(findings, "${FILE_CITE}")) + " of " + text(len(findings))`,
].join(' + ');

const LESSON_INPUTS = {
  problem: 'question',
  // The checked sub-answers, whole: not answer prose cut at a length.
  cause: 'subAnswers',
  files: 'citedFindings',
  open: 'openQuestions',
} as const;

/** Re-counted after every merge of findings: the tally the next readers steer by. */
const STATUS = [
  { field: 'hypothesisStatus', expr: 'stances(findings, hypotheses)' },
  // What the evidence readers get: nothing with readerHypotheses off (an ablation).
  { field: 'leadStatus', expr: 'if(readerHypotheses, hypothesisStatus, [])' },
];

/**
 * An assess answer in the fixed structure, from the gaps it should leave: each sub-question
 * listed is a GAP, the rest ANSWERED citing the first finding; open objections listed stay open.
 * For the demo and tests.
 */
export function assessFor(
  s: Readonly<Record<string, unknown>>,
  gaps: readonly string[],
): { assessment: string[]; objectionGaps: string[] } {
  const subs = (s.subQuestions as string[] | undefined) ?? [];
  const cite = /^(F[0-9]+)\s/.exec(((s.findings as string[] | undefined) ?? [])[0] ?? '')?.[1];
  const open = (s.openObjections as string[] | undefined) ?? [];
  return {
    assessment: subs.map((q, i) =>
      gaps.includes(q) || !cite
        ? `S${i + 1}: GAP — no cited evidence yet for ${q}`
        : `S${i + 1}: ANSWERED [${cite}]`,
    ),
    objectionGaps: open.filter((o) => gaps.includes(o)),
  };
}

const AGAINST =
  ' Look for evidence for AND against every entry of `leadHypotheses`, and tag each finding with the hypotheses it bears on, e.g. "[H2 against]". `leadStatus` counts those tags so far: look hardest at the hypotheses it marks untested or challenged. If `leadHypotheses` is empty, gather evidence on the question and sub-questions alone and do not tag findings.';

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

const RELEVANT = /engine|schema|validate/;

/** The demo's readers tag findings only when given hypotheses, as they are told. */
const tagged = (s: Readonly<Record<string, unknown>>, tag: string) =>
  ((s.leadHypotheses as string[] | undefined) ?? []).length > 0 ? tag : '';

/**
 * Thorough investigation that adapts its evidence to the question. The engine
 * owns every work queue; the planner only decides which kinds of evidence apply:
 *
 *   Plan research    list the evidence sources available; the AI splits the question and
 *                    decides, with a reason for every skip, which sources it needs
 *   List evidence    only what the plan needs: workspace files (repo questions), the web
 *                    pages worth reading (internet questions), experiments to run (behaviour
 *                    or performance questions). A repository with more than maxTriageFiles
 *                    files is searched first (locate) and only the files found are listed,
 *                    unless `exhaustive` asks for every file
 *   Triage files     every listed file, in batches; an answer that skips a file is rejected
 *   Deep read        every relevant file and every listed page, read completely
 *   Run experiments  after your approval, each experiment is run and measured
 *   Search sources   history, GitHub, dependencies, MCP: each chosen source searched
 *   Close gaps       unanswered sub-questions get targeted research, then a human hint
 *   Answer           cited, with a coverage report
 */
/** Unreadable items another fetch will not fix: PDFs and binaries, by path or by the reason given. */
const NO_RETRY =
  'unique(positions(notRead, "[.][Pp][Dd][Ff]([?#]|$)") + positions(notReadReasons, "[Bb]inary|PDF|[.]pdf|longer than one prompt|not found in the workspace|outside the workspace"))';

/**
 * Triage of a batch, whole files in the prompt. `deep` is the single-pass pilot (singlePass):
 * it also reads the relevant files in depth, following references and history, and lists in
 * `readFully` those it read completely, which then skip the deep read if the engine's own
 * record shows they were given whole.
 */
function triageStep(deep: boolean): ScoreNode {
  const node: ScoreNode = {
    id: 'triage',
    kind: 'agent',
    role: 'assessor',
    label: 'Triage files',
    directive:
      'Read EVERY file in `batch`: each one is given to you whole, with line numbers, at the end of this prompt (read all of it there, not just the top; open a file with tools only if it says lines were left out). Decide whether it is relevant to the question or any sub-question; when unsure, count it as relevant. Put every path of `batch` in `triaged`, the relevant ones in `batchRelevant`, and any concrete evidence you saw in `newFindings` as "path:line — fact".' +
      AGAINST,
    reads: ['leadHypotheses', 'leadStatus', 'question', 'hint', 'subQuestions', 'batch'],
    // The engine reads the batch whole: one turn per part instead of a tool call per page.
    preload: 'batch',
    // The engine says which files it could not show whole: those are not dismissed unseen.
    preloadReport: { paths: 'triagePartial', reasons: 'triagePartialReasons' },
    fanOut: { over: 'batch', per: 'batchSize', agents: 'agents' },
    writes: ['triaged', 'batchRelevant', 'newFindings'],
    cites: 'newFindings',
    retries: 2,
    complexityShift: -1,
    checks: [
      {
        expr: 'readerHypotheses || len(positions(newFindings, "[[]H[0-9]")) == 0',
        message: 'No hypotheses were given: do not tag findings with [H…].',
      },
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
  };
  if (!deep || node.kind !== 'agent') return node;
  return {
    ...node,
    id: 'triageDeep',
    label: 'Triage and read in depth',
    directive:
      node.directive +
      ' For each file you count as relevant, also read it as the deep read would: follow the references out of it that matter for the question (imports, callers, tests, config) and the history of the relevant lines (git log -p, git blame), and record every fact that bears on the question in `newFindings`. List in `readFully` the relevant files you read that way, completely; leave out any you only skimmed, and any the prompt says were not given whole: those get a deep read of their own.',
    // The engine says which it gave whole: readFully counts only for those.
    preloadReport: {
      paths: 'triagePartial',
      reasons: 'triagePartialReasons',
      whole: 'triageWhole',
    },
    writes: [...node.writes, 'readFully'],
    complexityShift: 0,
    checks: [
      ...(node.checks ?? []),
      {
        expr: 'subset(readFully, batchRelevant)',
        message: 'readFully may only list files of batchRelevant.',
      },
    ],
  };
}

export const investigate: Pattern = {
  name: 'investigate',
  description:
    'Answer a question thoroughly with the evidence it needs: repo files (big repos are searched first), web pages, experiments, history, GitHub, dependencies, MCP. Nothing listed is skipped; every claim is cited.',
  verbTriggers: ['investigate', 'explain', 'why', 'how does', 'find out', 'research'],
  requiredContext: ['question'],
  result: [
    'answer',
    'rulings',
    'openQuestions',
    'disagreements',
    'unresolvedObjections',
    // The evidence the answer rests on, so a chained run (fix, refactor…) need not find it again.
    'citedFindings',
    // Why a partial answer is partial.
    'doubts',
    // Each sub-question, answered (cited) or said to be open.
    'subAnswers',
  ],
  goalFrom: 'question',
  // A backstop, never the bound: the loops are bounded by their counters and the citation
  // checks' visit caps (a scripted worst case takes about 400-525 steps; exhaustive stops at a
  // check's cap near 1,200). Steps do not bound tokens or time, so a tighter number buys nothing,
  // and it must leave room for counters the maestro may raise per request.
  maxSteps: 5000,
  state: withState(
    [
      { name: 'question', type: 'string', description: 'What to find out' },
      { name: 'hint', type: 'string', description: 'Optional human clarification' },
      { name: 'hintAsked', type: 'boolean', description: 'A person was asked for a hint once' },
      { name: 'sourceNames', type: 'string[]', description: 'Evidence sources available' },
      { name: 'sourceInfo', type: 'string[]', description: 'How to use each source' },
      { name: 'subQuestions', type: 'string[]', description: 'Parts of the question to answer' },
      { name: 'planFacts', type: 'string[]', description: 'Facts recalled for the sub-questions' },
      {
        name: 'planLessons',
        type: 'string[]',
        description: 'Lessons recalled for the sub-questions',
      },
      {
        name: 'subAnswers',
        type: 'string[]',
        description: 'One per sub-question, in order: "S1: answer [F3]" or "S1: OPEN — why"',
      },
      {
        name: 'keepUnchallenged',
        type: 'boolean',
        description:
          'A rewrite after a challenge keeps word for word the sub-answers no REAL objection names (off: an A/B to run before turning it on)',
      },
      {
        name: 'prevSubAnswers',
        type: 'string[]',
        description: 'The sub-answers of the previous answer',
      },
      {
        name: 'objectionResolutions',
        type: 'string[]',
        description:
          'One per REAL objection the answer had to meet, in order and with its S tag: "S2: RESOLVED — how [F7]", "S2: REBUTTED — why it does not hold [F7]" or "S2: OPEN — what is missing"',
      },
      {
        name: 'doubts',
        type: 'string[]',
        description: 'Why the answer ended with open doubts (empty when it is settled)',
      },
      {
        name: 'citedFindings',
        type: 'string[]',
        description: 'The findings the answer cites, with their ids',
      },
      {
        name: 'parts',
        type: 'string[]',
        description:
          'Independent subjects the question asks about alike (e.g. several modules), each answered on its own from the shared evidence; empty = one answer',
      },
      {
        name: 'partAnswers',
        type: 'string[]',
        description: 'One section per part, answered side by side',
      },
      { name: 'searchTerms', type: 'string[]', description: 'Queries for search-based sources' },
      { name: 'useSources', type: 'string[]', description: 'Sources to use' },
      { name: 'skipSources', type: 'string[]', description: 'Sources not used' },
      { name: 'skipReasons', type: 'string[]', description: 'Why each skipped source was skipped' },
      { name: 'repoFiles', type: 'string[]', description: 'Every file in the workspace' },
      {
        name: 'narrowRead',
        type: 'boolean',
        description:
          'Opt-in, where every file would be triaged (at most maxTriageFiles files, or exhaustive): triage only the files the search matched plus narrowBudget more; every other file goes unread (zero coverage), each one listed. A larger repository is already narrowed by Locate (lower maxTriageFiles to narrow it further)',
      },
      {
        name: 'narrowBudget',
        type: 'number',
        initial: 20,
        description: 'With narrowRead: files beyond the matched ones, in ranked order',
      },
      {
        name: 'narrowedOut',
        type: 'string[]',
        description: 'Files the narrowed read left unread, each one listed',
      },
      {
        name: 'unlocatedFiles',
        type: 'string[]',
        description: "A big repository's files Locate did not find: not triaged, each one listed",
      },
      {
        name: 'rankedFiles',
        type: 'string[]',
        description: 'repoFiles, likeliest first (engine-ranked by the words of the question)',
      },
      {
        name: 'matchedFiles',
        type: 'string[]',
        description: 'Files sharing a word with the question',
      },
      {
        name: 'candidateFiles',
        type: 'string[]',
        description: "Locate's lead: the top matched files",
      },
      { name: 'excludedFiles', type: 'string[]', description: 'Files not triaged, with reasons' },
      { name: 'repoFileCount', type: 'number' },
      {
        name: 'maxTriageFiles',
        type: 'number',
        initial: 300,
        description:
          'Repositories with more files are searched first; only what is found is triaged',
      },
      {
        name: 'exhaustive',
        type: 'boolean',
        description: 'Triage every file even in a big repository (slow and costly)',
      },
      { name: 'scopeFiles', type: 'string[]', description: 'Files the search located' },
      { name: 'scopeReasons', type: 'string[]', description: 'Why, per located file' },
      { name: 'scopeQueries', type: 'string[]', description: 'Every search made to locate them' },
      { name: 'pages', type: 'string[]', description: 'Web pages to read in full (URLs)' },
      {
        name: 'experiments',
        type: 'string[]',
        description: 'Experiments to run: command, what it measures',
      },
      {
        name: 'timedExperiments',
        type: 'string[]',
        description: 'The experiments that time something: run one at a time, never side by side',
      },
      {
        name: 'parallelExperiments',
        type: 'string[]',
        description: 'The other experiments, run side by side',
      },
      {
        name: 'maxExperiments',
        type: 'number',
        initial: 12,
        // On whenever the plan needs them: commands run in the workspace (after your approval).
        // 0 would ask for experiments and allow none.
        min: 1,
        description:
          'Experiments the plan may run when it needs them (commands in the workspace, after approval)',
      },
      {
        name: 'agents',
        type: 'number',
        initial: MAX_AGENTS,
        description: `Parallel sub-agents for triage, deep reads and parts (1 to ${MAX_AGENTS}), chosen when planning`,
      },
      {
        name: 'agentsCap',
        type: 'number',
        initial: MAX_AGENTS,
        description: `At most this many parallel sub-agents, whatever the plan chose (a trial: 4 vs ${MAX_AGENTS})`,
      },
      // Files per sub-agent: read whole in its prompt, so fewer than when it paged through them.
      { name: 'batchSize', type: 'number', initial: 10 },
      {
        name: 'batchWave',
        type: 'number',
        // batchSize × agents (set after planning): no slot sits idle.
        initial: 180,
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
        initial: 72,
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
        name: 'partlyRead',
        type: 'string[]',
        description: 'Files of the deep batch the engine could not give whole (engine-filled)',
      },
      { name: 'partlyReadReasons', type: 'string[]', description: 'Why, by position' },
      {
        name: 'partialAt',
        type: 'number[]',
        description: 'Positions of partlyRead not yet reported',
      },
      {
        name: 'partlyRest',
        type: 'string[]',
        description:
          'By position with partlyRead: the chunk of remaining lines to read next, or ""',
      },
      {
        name: 'unreadAt',
        type: 'number[]',
        description: 'Positions of partlyRead with nothing given',
      },
      {
        name: 'readNotes',
        type: 'string[]',
        description: 'One per item of the deep batch, in order: "<item> — what it holds"',
      },
      { name: 'readLog', type: 'string[]', description: 'Every readNotes entry, wave after wave' },
      {
        name: 'triagePartial',
        type: 'string[]',
        description: 'Files of the triage batch the engine could not give whole (engine-filled)',
      },
      { name: 'triagePartialReasons', type: 'string[]', description: 'Why, by position' },
      {
        name: 'singlePass',
        type: 'boolean',
        description:
          'Pilot (off): triage also reads relevant files in depth, and those the engine shows it gave whole skip the deep read',
      },
      {
        name: 'readFully',
        type: 'string[]',
        description: 'Relevant files the pilot triage read completely',
      },
      {
        name: 'triageWhole',
        type: 'string[]',
        description:
          'Files of the triage batch the engine gave whole (engine-filled; empty without a record)',
      },
      {
        name: 'supportJudge',
        type: 'string',
        initial: 'off',
        description:
          "Does each cited finding's quote support its claim? off; shadow (judged and reported, the outcome unchanged); enforce (unsupported ones make the answer partial). Off until calibrated.",
      },
      {
        name: 'judgeItems',
        type: 'string[]',
        description:
          'Cited findings the judge can check: workspace path:line ones, with their quotes',
      },
      {
        name: 'supportRulings',
        type: 'string[]',
        description:
          'One per judgeItems entry, in order: "F12: SUPPORTED — why" or "F12: UNSUPPORTED — why"',
      },
      { name: 'unsupportedIds', type: 'string[]', description: 'Cited findings ruled UNSUPPORTED' },
      { name: 'judgeBatch', type: 'number', initial: 40, description: 'Findings per judge call' },
      {
        name: 'factsToKeep',
        type: 'string[]',
        description: 'Cited findings remembered for later runs: all but the ones ruled unsupported',
      },
      {
        name: 'readerHypotheses',
        type: 'boolean',
        initial: true,
        description:
          'Give the hypotheses to the evidence readers (off: an ablation; assess, the answer and the debate keep them)',
      },
      { name: 'leadHypotheses', type: 'string[]', description: 'The hypotheses the readers get' },
      { name: 'leadStatus', type: 'string[]', description: 'The tally the readers get' },
      {
        name: 'hypothesisStatus',
        type: 'string[]',
        description:
          'Per hypothesis, findings tagged for and against it (engine-counted); none is dropped',
      },
      {
        name: 'noRetryAt',
        type: 'number[]',
        description: 'Positions in notRead that another fetch cannot help (PDF, binary)',
      },
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
      {
        name: 'currentSources',
        type: 'string[]',
        description: 'Sources to search now, one sub-agent each',
      },
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
      {
        name: 'assessment',
        type: 'string[]',
        description:
          'One per sub-question, in order: "S<n>: ANSWERED [F…]" or "S<n>: GAP — what is missing"',
      },
      {
        name: 'objectionGaps',
        type: 'string[]',
        description: 'Open objections the findings do not yet settle',
      },
      { name: 'gapNotes', type: 'string[]', description: 'The GAP entries of the assessment' },
      {
        name: 'gapQuestions',
        type: 'string[]',
        description: 'The sub-questions the assessment marks GAP',
      },
      {
        name: 'gapAimed',
        type: 'boolean',
        description:
          'Pilot (off): the gap research gets what the gap check says is missing instead of the whole sub-question',
      },
      {
        name: 'chaseGaps',
        type: 'string[]',
        description: 'What the gap research is asked to close',
      },
      {
        name: 'expandRounds',
        type: 'number',
        description: 'Times the gaps sent more workspace files to the deep read',
      },
      {
        name: 'maxExpandRounds',
        type: 'number',
        initial: 2,
        description: 'Cap on expandRounds (0: never expand)',
      },
      {
        name: 'expandWave',
        type: 'number',
        initial: 8,
        description: 'Files at most a gap expansion adds to the deep read',
      },
      {
        name: 'expandPool',
        type: 'string[]',
        description: 'Workspace files not yet read in depth',
      },
      { name: 'gapRanked', type: 'string[]' },
      {
        name: 'gapMatched',
        type: 'string[]',
        description: 'Unread files that share words with the gaps',
      },
      { name: 'expandNew', type: 'string[]', description: 'Files the last expansion queued' },
      { name: 'expandedFiles', type: 'string[]', description: 'Every file a gap expansion queued' },
      {
        name: 'expanding',
        type: 'boolean',
        description: 'The deep read in progress is a gap expansion',
      },
      {
        name: 'deepBatchUsual',
        type: 'number',
        description: 'deepBatchSize before the retry pass set it to 1',
      },
      { name: 'gapRounds', type: 'number' },
      { name: 'maxGapRounds', type: 'number', initial: 2 },
      { name: 'chaseRounds', type: 'number', description: 'Gap research rounds in the whole run' },
      {
        name: 'maxChaseRounds',
        type: 'number',
        // gapRounds starts again after a hint and on each debate round; this one never does.
        initial: 8,
        description: 'Gap research rounds for the whole run, across hints and debate rounds',
      },
      {
        name: 'gapsPerChase',
        type: 'number',
        initial: 99,
        description:
          'Gaps per gap-research call: 99 researches them all in one call; 1 gives each gap its own sub-agent (faster, more tokens)',
      },
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
      nodes: ['catalog', 'plan', 'recallPlan', 'mergeRecall', 'queue'],
    },
    hypotheses.group,
    {
      id: 'listPhase',
      label: 'List evidence',
      description:
        'Only what the plan needs: workspace files, likeliest first (a big repo is searched first), web pages, experiments',
      nodes: [
        'leads',
        'needFiles',
        'inventory',
        'rankFiles',
        'countFiles',
        'smallRepo',
        'queueFiles',
        'locate',
        'queueScope',
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
      nodes: [
        'filesLeft',
        'takeBatch',
        'singlePassOn',
        'triage',
        'triageDeep',
        'checkTriage',
        'mergeTriage',
      ],
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
        'hasParallel',
        'parallelExperiment',
        'checkParallel',
        'mergeParallel',
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
        'recordGaps',
        'expandGaps',
        'expandPoolOf',
        'rankGaps',
        'takeExpand',
        'expanded',
        'expandDone',
        'endExpand',
        'moreGaps',
        'aimChase',
        'chase',
        'checkChase',
        'mergeChase',
        'confident',
        'clarify',
        'useHint',
      ],
    },
    challenge.group,
    {
      id: 'judgePhase',
      label: 'Support judge',
      description: "Off by default: does each cited finding's quote back its claim?",
      nodes: ['useJudge', 'takeJudgeItems', 'hasJudgeItems', 'judgeSupport', 'splitRulings'],
    },
  ],
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    recallMemory('recall', 'question'),
    {
      // Again with the sub-questions: the raw question is a poor query for the parts of it.
      id: 'recallPlan',
      kind: 'tool',
      label: 'Recall for the sub-questions',
      tool: 'memory.recall',
      inputs: { query: 'subQuestions' },
      output: { facts: 'planFacts', lessons: 'planLessons' },
    },
    {
      id: 'mergeRecall',
      kind: 'compute',
      label: 'Merge recalled leads',
      assign: [
        // The same caps as one recall: more related leads are distractors, not help.
        { field: 'knownFacts', expr: 'take(unique(knownFacts + planFacts), 12)' },
        { field: 'pastLessons', expr: 'take(unique(pastLessons + planLessons), 6)' },
      ],
    },
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
      directive: `Plan a thorough investigation of \`question\` (use \`hint\` if set). Split it into concrete sub-questions. Then decide, for EVERY source in \`sourceInfo\`, whether it can hold evidence for this question: put it in \`useSources\` or in \`skipSources\` with one reason per skip in \`skipReasons\`. Match the evidence to the question: questions about this codebase need \`workspace\`; questions about the outside world (libraries, standards, other projects) need \`web\`; questions about behaviour or performance (does it work, why is it slow, which is faster) need \`experiment\` to reproduce or measure; why-questions about code usually need \`git-history\`. Prefer using a source over skipping it. Write \`searchTerms\` as concrete queries for web, GitHub, history and MCP searches. If the question asks the same thing about several independent subjects (e.g. "how can A, B and C be improved", "compare X, Y and Z"), list each subject once in \`parts\` (2 to ${MAX_PARTS}): the evidence is gathered once for all of them, then each part is answered on its own, side by side. Otherwise leave \`parts\` empty. Set \`agents\` to how many sub-agents should read in parallel (1 to ${MAX_AGENTS}): ${MAX_AGENTS} unless the question is narrow, 1-3 for one about a few files; parallel calls finish sooner at the same total reading, and an idle slot only costs time.`,
      reads: ['question', 'hint', 'sourceNames', 'sourceInfo'],
      writes: [
        'subQuestions',
        'searchTerms',
        'useSources',
        'skipSources',
        'skipReasons',
        'parts',
        'agents',
      ],
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
        {
          expr: `len(parts) != 1 && len(parts) <= ${MAX_PARTS}`,
          message: `List 2 to ${MAX_PARTS} independent subjects in parts, or none.`,
        },
        {
          expr: `agents >= 1 && agents <= ${MAX_AGENTS}`,
          message: `Set agents to a whole number from 1 to ${MAX_AGENTS}.`,
        },
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
        // The plan chooses the sub-agents; agentsCap (a trial setting) caps that choice.
        { field: 'agents', expr: 'if(agents > agentsCap, agentsCap, agents)' },
        // Each wave gives every sub-agent three parts, one after the other: fewer pauses between waves.
        { field: 'batchWave', expr: 'batchSize * agents * 3' },
        { field: 'deepWave', expr: 'deepBatchSize * agents * 3' },
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
      // An order for reading, not a filter: every file is still triaged (small repos), and
      // the likeliest come first, so the first waves carry most of the evidence.
      id: 'rankFiles',
      kind: 'tool',
      label: 'Rank files',
      tool: 'repo.rank',
      inputs: {
        paths: 'repoFiles',
        question: 'question',
        subQuestions: 'subQuestions',
        searchTerms: 'searchTerms',
        hint: 'hint',
      },
      output: { ranked: 'rankedFiles', matched: 'matchedFiles' },
    },
    {
      id: 'countFiles',
      kind: 'compute',
      label: 'Count files',
      assign: [
        { field: 'repoFileCount', expr: 'len(repoFiles)' },
        // The engine's lexical candidates, a lead for Locate in a big repository.
        { field: 'candidateFiles', expr: 'take(matchedFiles, 50)' },
      ],
    },
    {
      id: 'smallRepo',
      kind: 'condition',
      label: 'Triage every file?',
      expression: 'repoFileCount <= maxTriageFiles || exhaustive',
    },
    {
      id: 'queueFiles',
      kind: 'compute',
      label: 'Queue files',
      assign: [
        {
          field: 'pendingFiles',
          // The ranked order only when it is the same files: an order never drops one.
          expr: 'if(len(rankedFiles) == len(repoFiles) && subset(repoFiles, rankedFiles), rankedFiles, repoFiles)',
        },
        // narrowRead (opt-in): every file the search matched (the floor), then narrowBudget more
        // in ranked order. The rest are never read, and each is named in the coverage.
        {
          field: 'narrowedOut',
          expr: 'if(narrowRead, drop(without(pendingFiles, matchedFiles), narrowBudget), [])',
        },
        { field: 'pendingFiles', expr: 'without(pendingFiles, narrowedOut)' },
        {
          field: 'excludedFiles',
          expr: 'if(len(narrowedOut) > 0, append(excludedFiles, text(len(narrowedOut)) + " files were left unread by the narrowed read (opt-in: not matched by the search, and past narrowBudget): see narrowedOut"), excludedFiles)',
        },
      ],
    },
    {
      id: 'locate',
      kind: 'agent',
      role: 'assessor',
      label: 'Locate files',
      directive:
        "This repository has too many files (`repoFileCount`) to triage each one, so first locate where the evidence can be. Search the workspace (read-only): `git grep` or ripgrep for the names, identifiers, error messages, test names and paths in `question`, `hint` and `searchTerms`; `git log` and `git show` for the commits, pull requests, branches or dates it mentions (the files a change touched come first); then follow imports, callers and tests one level out from what you find. `candidateFiles` are the files the engine's own search ranked highest for these words: a lead, check them, and look beyond them. List in `scopeFiles` the files that could hold evidence for or against any entry of `leadHypotheses` (or on the question, when it is empty), most likely first, at most `maxTriageFiles`, as paths relative to the repository root exactly as `git ls-files` prints them (files, not folders). At the same position in `scopeReasons`, say why: which search found it. Record every search you ran in `scopeQueries`.",
      reads: [
        'question',
        'hint',
        'subQuestions',
        'searchTerms',
        'leadHypotheses',
        'repoFileCount',
        'maxTriageFiles',
        'knownFacts',
        'candidateFiles',
      ],
      writes: ['scopeFiles', 'scopeReasons', 'scopeQueries'],
      retries: 2,
      checks: [
        { expr: 'len(scopeFiles) > 0', message: 'Locate at least one file.' },
        {
          expr: 'len(scopeFiles) <= maxTriageFiles',
          message: 'List at most maxTriageFiles files: the most likely ones.',
        },
        {
          expr: 'subset(scopeFiles, repoFiles)',
          message:
            'scopeFiles may only list files of this repository, relative to its root exactly as `git ls-files` prints them (no folders, no globs).',
        },
        {
          expr: 'len(scopeReasons) == len(scopeFiles)',
          message: 'Give one reason in scopeReasons per entry of scopeFiles, in the same order.',
        },
        { expr: 'len(scopeQueries) > 0', message: 'Record the searches you ran in scopeQueries.' },
      ],
    },
    {
      id: 'queueScope',
      kind: 'compute',
      label: 'Queue located files',
      assign: [
        // What Locate found, plus the engine's candidates: a union, so neither can hide a file.
        { field: 'pendingFiles', expr: 'unique(scopeFiles + candidateFiles)' },
        // Every file not triaged is named, not summed up: the coverage lists them all.
        { field: 'unlocatedFiles', expr: 'without(repoFiles, pendingFiles)' },
        {
          field: 'excludedFiles',
          expr: 'append(excludedFiles, text(len(unlocatedFiles)) + " files the search did not locate were not triaged (more than maxTriageFiles files; set exhaustive to triage every file): see unlocatedFiles")',
        },
      ],
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
        'Design the experiments that would answer the behaviour or performance parts of `question`: each entry of `experiments` is one experiment as "command(s) to run — what it measures or reproduces — how to read the result". Make them fair and repeatable (same inputs, warm-up, at least 3 timed repetitions for performance). Never anything that edits tracked files, installs globally, or needs secrets. At most `maxExperiments`, the most telling first. Copy into `timedExperiments`, verbatim, every experiment that measures time or speed: those run one at a time, since timings taken side by side skew each other; the rest run in parallel.',
      reads: ['question', 'hint', 'subQuestions', 'sourceInfo', 'maxExperiments'],
      writes: ['experiments', 'timedExperiments'],
      retries: 2,
      checks: [
        { expr: 'len(experiments) > 0', message: 'Design at least one experiment.' },
        {
          expr: 'len(experiments) <= maxExperiments',
          message: 'Keep the most telling experiments, at most maxExperiments.',
        },
        {
          expr: 'subset(timedExperiments, experiments)',
          message: 'timedExperiments must be copied verbatim from experiments.',
        },
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
        { field: 'batch', expr: 'take(pendingFiles, batchWave)' },
        { field: 'pendingFiles', expr: 'drop(pendingFiles, batchWave)' },
      ],
    },
    {
      id: 'singlePassOn',
      kind: 'condition',
      label: 'Single pass? (pilot)',
      expression: 'singlePass',
    },
    triageStep(false),
    triageStep(true),
    checkFindings('checkTriage', 'newFindings', false),
    {
      id: 'mergeTriage',
      kind: 'compute',
      label: 'Record triage',
      assign: [
        {
          field: 'relevantFiles',
          // A file triage saw only part of goes to the deep read, whatever triage said.
          // The pilot's readFully skip the deep read only where the engine's record shows the
          // file was given whole (an intersection: without a record, none skip).
          // Any file triage was not given whole (cut, unreadable, or missing from the record)
          // counts as unseen: it goes to the deep read, whatever triage said.
          expr: 'relevantFiles + without(batchRelevant, without(readFully, without(readFully, triageWhole))) + without(triagePartial, batchRelevant)',
        },
        ...MERGE_FINDINGS,
        ...STATUS,
        // Each wave's claims are its own.
        { field: 'readFully', expr: '[]' },
        { field: 'triageWhole', expr: '[]' },
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
        'Read every item of `deepBatch` completely. Workspace files are given to you whole, with line numbers, at the end of this prompt: read every line there (do not re-open them), then follow the references out of them that matter for the question (imports, callers, tests, config) and the history of the relevant lines (git log -p, git blame). Web pages (URLs): fetch and read the whole page, following links that matter. Record every fact that bears on the question as "path:line — fact" or "URL — fact" in `newFindings`. List each item of `deepBatch` you read completely in `examined`. In `readNotes`, give one entry per item of `deepBatch`, in order, starting with the item exactly as listed: "<item> — what it holds for the question" (or "<item> — nothing relevant"). An item "path#chunk=from-to" is lines from-to of path, the rest of a file too long for one prompt: cite its facts as "path:line" with the line numbers of the file. If an item cannot be read in full (HTTP errors, rate limits, truncated or paywalled pages, unreadable files), do not pretend (items you could not read before come back once for another try): put it in `unreadable` and, at the same position, say why and how much you did read in `unreadableReasons`.' +
        AGAINST,
      // The engine reads the workspace files of the batch whole: one turn, nothing skipped.
      preload: 'deepBatch',
      // "Read completely" is held to what the engine gave, not to what the AI says it read.
      preloadReport: {
        paths: 'partlyRead',
        reasons: 'partlyReadReasons',
        rest: 'partlyRest',
      },
      reads: ['leadHypotheses', 'leadStatus', 'question', 'hint', 'subQuestions', 'deepBatch'],
      fanOut: { over: 'deepBatch', per: 'deepBatchSize', agents: 'agents' },
      writes: ['examined', 'newFindings', 'unreadable', 'unreadableReasons', 'readNotes'],
      cites: 'newFindings',
      retries: 2,
      checks: [
        {
          expr: 'readerHypotheses || len(positions(newFindings, "[[]H[0-9]")) == 0',
          message: 'No hypotheses were given: do not tag findings with [H…].',
        },
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
        {
          // Output for every item, by the item each note starts with: none left out.
          expr: 'heads(readNotes, "^[^ ]+") == deepBatch',
          message:
            'Give exactly one readNotes entry per item of deepBatch, in the same order, each starting with the item exactly as listed, then " — " and what it holds.',
        },
      ],
    },
    {
      id: 'retryUnread',
      kind: 'condition',
      label: 'Retry unreadable?',
      // Rate limits and timeouts often clear by the end of deep reading: one more try, then report.
      // A PDF or binary fails the same way every time: only the rest are worth another try.
      expression: `len(notRead) > len(${NO_RETRY}) && unreadRetries < maxUnreadRetries`,
    },
    {
      id: 'requeueUnread',
      kind: 'compute',
      label: 'Queue unreadable again',
      assign: [
        { field: 'noRetryAt', expr: NO_RETRY },
        { field: 'pendingDeep', expr: 'without(notRead, pick(notRead, noRetryAt))' },
        { field: 'notReadReasons', expr: 'pick(notReadReasons, noRetryAt)' },
        { field: 'notRead', expr: 'pick(notRead, noRetryAt)' },
        { field: 'deepBatchUsual', expr: 'if(unreadRetries == 0, deepBatchSize, deepBatchUsual)' },
        { field: 'unreadRetries', expr: 'unreadRetries + 1' },
        // One item per call: a file cut for the call's size gets the whole budget to itself.
        { field: 'deepBatchSize', expr: '1' },
      ],
    },
    checkFindings('checkDeep', 'newFindings', false),
    {
      id: 'mergeDeep',
      kind: 'compute',
      label: 'Record deep read',
      assign: [
        ...MERGE_FINDINGS,
        ...STATUS,
        // The engine's record decides what was read, whatever the AI says. Cut short: the rest
        // is read next, as a range, first in the queue (a full prompt to itself). Not given at
        // all (unreadable, or missing from the record): reported, and retried once at the end.
        { field: 'partialAt', expr: 'outside(partlyRead, notRead + unreadable)' },
        { field: 'unreadAt', expr: 'without(partialAt, positions(partlyRest, "."))' },
        { field: 'notRead', expr: 'notRead + unreadable + pick(partlyRead, unreadAt)' },
        {
          field: 'notReadReasons',
          expr: 'notReadReasons + unreadableReasons + pick(partlyReadReasons, unreadAt)',
        },
        { field: 'pendingDeep', expr: 'without(partlyRest, [""]) + pendingDeep' },
        // What the reader said of each item, wave after wave.
        { field: 'readLog', expr: 'readLog + readNotes' },
        { field: 'readNotes', expr: '[]' },
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
      assign: [
        { field: 'parallelExperiments', expr: 'without(experiments, timedExperiments)' },
        { field: 'pendingExperiments', expr: 'timedExperiments' },
      ],
    },
    {
      id: 'hasParallel',
      kind: 'condition',
      label: 'Untimed experiments?',
      expression: 'len(parallelExperiments) > 0',
    },
    {
      id: 'parallelExperiment',
      kind: 'agent',
      role: 'executor',
      label: 'Run experiments side by side',
      // One sub-agent per experiment that times nothing, as many at once as the plan chose.
      fanOut: { over: 'parallelExperiments', per: 1, agents: 'agents' },
      directive:
        'Run the ONE experiment in `parallelExperiments` in the workspace. Other experiments run at the same time: do not modify tracked files, and keep scripts and output in a subfolder of the scratch folder named in your instructions that no one else uses (e.g. named after your experiment). Record every command you ran in `queries` and each result, with its numbers and the command, in `newFindings` as "experiment | <command> — result". If it cannot run, say exactly why in `newFindings`.',
      reads: ['question', 'parallelExperiments'],
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
    checkFindings('checkParallel', 'newFindings', false),
    {
      id: 'mergeParallel',
      kind: 'compute',
      label: 'Record experiments',
      assign: [...MERGE_FINDINGS, ...STATUS, { field: 'ran', expr: 'ran + parallelExperiments' }],
    },
    {
      id: 'experimentsLeft',
      kind: 'condition',
      label: 'Timed experiments left?',
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
      visitsFrom: 'maxExperiments + 2',
      label: 'Run timed experiment',
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
    checkFindings('checkExperiment', 'newFindings', false),
    {
      id: 'mergeExperiment',
      kind: 'compute',
      label: 'Record experiment',
      assign: [
        ...MERGE_FINDINGS,
        ...STATUS,
        { field: 'ran', expr: 'append(ran, currentExperiment)' },
      ],
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
        // As many sources as there are sub-agents, searched side by side.
        { field: 'currentSources', expr: 'take(pendingSources, agents)' },
        { field: 'pendingSources', expr: 'drop(pendingSources, agents)' },
      ],
    },
    {
      id: 'sweep',
      kind: 'agent',
      role: 'assessor',
      label: 'Search source',
      capabilities: ['web', 'mcp'],
      directive:
        'Search the ONE source in `currentSources` (see `sourceInfo` for how to use it) for evidence on every sub-question, using `searchTerms` and your own follow-up queries. Be exhaustive: look at several results, read full pages, threads, issues and diffs, and follow links. Record every query, command or tool call in `queries`, and every relevant fact as "source | location (URL, issue/PR #, commit, tool) — fact" in `newFindings`. If the source has nothing relevant, add one finding saying what you searched.' +
        AGAINST,
      reads: [
        'leadHypotheses',
        'leadStatus',
        'question',
        'hint',
        'subQuestions',
        'searchTerms',
        'currentSources',
        'sourceInfo',
      ],
      writes: ['queries', 'newFindings'],
      cites: 'newFindings',
      // Sources are independent: one sub-agent each.
      fanOut: { over: 'currentSources', per: 1, agents: 'agents' },
      retries: 2,
      checks: [
        {
          expr: 'readerHypotheses || len(positions(newFindings, "[[]H[0-9]")) == 0',
          message: 'No hypotheses were given: do not tag findings with [H…].',
        },
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
    checkFindings('checkSource', 'newFindings', false),
    {
      id: 'mergeSource',
      kind: 'compute',
      label: 'Record source',
      assign: [
        ...MERGE_FINDINGS,
        ...STATUS,
        { field: 'consulted', expr: 'consulted + currentSources' },
      ],
    },
    {
      id: 'assess',
      kind: 'agent',
      role: 'assessor',
      label: 'Find gaps',
      directive:
        'For EACH sub-question, in order, decide whether `findingsBrief` (the findings, quotes left out) answer it with concrete, cited evidence. In `assessment`, give one entry per sub-question, in order: "S<n>: ANSWERED [F…]" citing the findings that answer it, or "S<n>: GAP — what is missing" (the evidence still needed, and where it might be: name files, functions or terms). In `objectionGaps`, copy exactly every entry of `openObjections` (objections to the last answer, sent back to research) that the findings do not yet settle. A hypothesis that `hypothesisStatus` marks untested is a gap only if a sub-question needs it settled. Set `confidence` (0..1) that the findings fully answer `question`: it is reported; the gaps, not the confidence, decide whether research goes on.',
      reads: [
        'question',
        'hint',
        'subQuestions',
        'openObjections',
        'hypothesisStatus',
        'findingsBrief',
        'skipSources',
        'skipReasons',
      ],
      writes: ['assessment', 'objectionGaps', 'confidence'],
      retries: 2,
      checks: [
        {
          expr: `${TAGS('assessment')} == seq("S", len(subQuestions))`,
          message:
            'Give exactly one assessment entry per sub-question, in order, starting "S1: ", "S2: " and so on.',
        },
        {
          expr: 'len(unmatched(assessment, "^S[0-9]+: (ANSWERED .*[[]F[0-9]+|GAP .*[A-Za-z])")) == 0',
          message:
            'Write each assessment entry as "S<n>: ANSWERED [F…]" citing findings, or "S<n>: GAP — what is missing".',
        },
        {
          expr: 'subset(refs(assessment), ids(findings))',
          message: 'assessment may cite only ids that exist in findings.',
        },
        {
          expr: 'subset(objectionGaps, openObjections)',
          message: 'objectionGaps must be copied exactly from openObjections.',
        },
      ],
    },
    {
      id: 'recordGaps',
      kind: 'compute',
      label: 'Record gaps',
      // The gaps follow from the assessment, entry by entry: the engine derives them.
      assign: [
        { field: 'gapNotes', expr: 'pick(assessment, positions(assessment, "^S[0-9]+: GAP"))' },
        {
          field: 'gapQuestions',
          expr: 'pick(subQuestions, positions(assessment, "^S[0-9]+: GAP"))',
        },
        {
          field: 'gaps',
          expr: 'pick(subQuestions, positions(assessment, "^S[0-9]+: GAP")) + objectionGaps',
        },
      ],
    },
    {
      id: 'expandGaps',
      kind: 'condition',
      label: 'Expand the read?',
      // Gaps first send the workspace files that share their words to the deep read.
      expression:
        'len(gaps) > 0 && expandRounds < maxExpandRounds && includes(useSources, "workspace") && len(repoFiles) > 0',
    },
    {
      id: 'expandPoolOf',
      kind: 'compute',
      label: 'Unread files',
      assign: [{ field: 'expandPool', expr: 'without(repoFiles, relevantFiles + notRead)' }],
    },
    {
      // Deterministic: the engine ranks the unread files by the words of the gaps.
      id: 'rankGaps',
      kind: 'tool',
      label: 'Rank by the gaps',
      tool: 'repo.rank',
      inputs: { paths: 'expandPool', subQuestions: 'gapNotes', searchTerms: 'objectionGaps' },
      output: { ranked: 'gapRanked', matched: 'gapMatched' },
    },
    {
      id: 'takeExpand',
      kind: 'compute',
      label: 'Queue gap files',
      assign: [
        { field: 'expandNew', expr: 'take(without(gapMatched, relevantFiles), expandWave)' },
        { field: 'expandRounds', expr: 'expandRounds + 1' },
        { field: 'expandedFiles', expr: 'expandedFiles + expandNew' },
        // A file the narrowed read left out that a gap brings in is read after all.
        { field: 'narrowedOut', expr: 'without(narrowedOut, expandNew)' },
        { field: 'relevantFiles', expr: 'relevantFiles + expandNew' },
        { field: 'pendingDeep', expr: 'pendingDeep + expandNew' },
        { field: 'expanding', expr: 'len(expandNew) > 0' },
        // A wave reads as many items per call as the first did, not one as the retry pass.
        { field: 'deepBatchSize', expr: 'if(unreadRetries > 0, deepBatchUsual, deepBatchSize)' },
      ],
    },
    {
      id: 'expanded',
      kind: 'condition',
      label: 'Files queued?',
      expression: 'expanding',
    },
    {
      id: 'expandDone',
      kind: 'condition',
      label: 'Gap expansion read?',
      expression: 'expanding',
    },
    {
      id: 'endExpand',
      kind: 'compute',
      label: 'Back to the gaps',
      assign: [{ field: 'expanding', expr: 'false' }],
    },
    {
      id: 'moreGaps',
      kind: 'condition',
      label: 'Chase gaps?',
      expression: 'len(gaps) > 0 && gapRounds < maxGapRounds && chaseRounds < maxChaseRounds',
    },
    {
      id: 'chase',
      kind: 'agent',
      role: 'assessor',
      label: 'Close gaps',
      capabilities: ['web', 'mcp'],
      // gapsPerChase 1: one sub-agent per gap, each with the whole brief (for an A/B).
      fanOut: { over: 'chaseGaps', per: 'gapsPerChase', agents: 'agents', warm: true },
      directive:
        'Close every gap in `chaseGaps` with targeted research, using ANY source in `sourceInfo` (including ones skipped before) and `hint` if set. Record every query, command or tool call in `queries` and every fact as "source | location — fact" in `newFindings`. If a gap has no evidence anywhere, add a finding saying where you looked.' +
        AGAINST,
      reads: [
        'leadHypotheses',
        'leadStatus',
        'question',
        'chaseGaps',
        'hint',
        'findingsBrief',
        'sourceInfo',
        'consulted',
      ],
      writes: ['queries', 'newFindings'],
      cites: 'newFindings',
      retries: 2,
      checks: [
        {
          expr: 'readerHypotheses || len(positions(newFindings, "[[]H[0-9]")) == 0',
          message: 'No hypotheses were given: do not tag findings with [H…].',
        },
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
    checkFindings('checkChase', 'newFindings', false),
    {
      id: 'aimChase',
      kind: 'compute',
      label: 'Aim the research',
      // gapAimed (a pilot, off): research what the gap check says is missing, not the whole
      // sub-question. Only while the gaps are still the check's own (not objections sent back).
      assign: [
        {
          field: 'chaseGaps',
          expr: 'if(gapAimed && gaps == gapQuestions + objectionGaps, gapNotes + objectionGaps, gaps)',
        },
      ],
    },
    {
      id: 'mergeChase',
      kind: 'compute',
      label: 'Record gap research',
      assign: [
        ...MERGE_FINDINGS,
        ...STATUS,
        { field: 'gapRounds', expr: 'gapRounds + 1' },
        { field: 'chaseRounds', expr: 'chaseRounds + 1' },
      ],
    },
    {
      id: 'confident',
      kind: 'condition',
      label: 'Gaps closed?',
      // On the record, never the model's confidence: no gap left in the checked assessment
      // and nothing queued to read. Otherwise a person is asked once for a hint.
      expression: '(len(gaps) == 0 && len(pendingDeep) == 0) || !empty(hint) || hintAsked',
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
        // Asked once; an empty hint stays empty rather than a placeholder passing as one.
        { field: 'hintAsked', expr: 'true' },
        { field: 'gapRounds', expr: '0' },
      ],
    },
    {
      id: 'multiPart',
      kind: 'condition',
      label: 'Several parts?',
      expression: 'len(parts) > 1',
    },
    {
      id: 'answerParts',
      kind: 'agent',
      role: 'assessor',
      label: 'Answer each part',
      // One call per part, side by side: each stays on its own subject over the shared
      // evidence, instead of one call answering everything and drifting or running out.
      // The parts share everything but their subject: the first one warms the prompt cache.
      fanOut: { over: 'parts', per: 1, agents: 'agents', warm: true },
      directive:
        'Answer `question` for the ONE subject in `parts` only, using only `findingsBrief` (the findings, quotes left out). ' +
        CITE_BY_ID +
        ' Findings in `unverified` could not be verified: do not rely on them. Write exactly one `partAnswers` entry: a Markdown section that starts with "## " and the subject, says what the evidence shows about it and what follows from it (for the question asked), and cites finding ids. Stay on your subject: say what holds for every subject in one closing line starting "Shared:" rather than at length. If `realObjections` (objections to the last answer, tagged with the sub-question they bear on) touch your subject, meet them with the evidence. No coverage section; the overall answer has it.',
      reads: [
        'question',
        'parts',
        'subQuestions',
        'hint',
        'findingsBrief',
        'gaps',
        'unverified',
        'realObjections',
      ],
      writes: ['partAnswers'],
      retries: 2,
      checks: [
        {
          expr: 'len(partAnswers) == len(parts)',
          message: 'Write exactly one partAnswers entry per subject in parts.',
        },
        citesFindings('partAnswers'),
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
        ' Findings the engine could not verify are in `unverified`: do not rely on them. Do not write a coverage section: the engine adds one from its record (files excluded, pages, experiments, sources, what could not be read). In `subAnswers`, give one entry per entry of `subQuestions`, in order: "S<n>: <its answer in one or two sentences> [F…]" citing the findings it rests on, or "S<n>: OPEN — <what is missing>" when the findings do not answer it. Put anything still unknown in `openQuestions`, in your own words (remaining `gaps` are added for you). In `rulings`, give one entry per hypothesis, in order: "H<n>: CONFIRMED | REFUTED | UNKNOWN — the evidence"; never confirm one without evidence for it or refute one without evidence against it, and say why when a ruling goes against the tally in `hypothesisStatus`. If `realObjections` is set, the answer was challenged: in `objectionResolutions` give one entry per objection, in order, starting with its S tag: "S<n>: RESOLVED — what the evidence now shows [F…]", "S<n>: REBUTTED — why it does not hold [F…]", or "S<n>: OPEN — what is still missing" (open ones are reported as open questions); leave it empty when nothing was challenged. When `keepUnchallenged` is true, keep word for word every `prevSubAnswers` entry no objection names by its S tag. Before you finish, read your answer as its skeptic will: every claim backed by a cited finding, no hypothesis dismissed without evidence against it, no alternative explanation the evidence also fits left unsaid, no path nobody followed (a caller, a config, a version, an environment) presented as settled. If `partAnswers` is set, each answers one subject of `parts` and is attached after your answer, verbatim: do not repeat them. Write what holds across them instead: the most important points first (e.g. a short ranked list naming the subjects), then anything shared; correct a part here if newer findings contradict it.',
      reads: [
        'question',
        'hint',
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
        'hypothesisStatus',
        'disagreements',
        'unverified',
        'parts',
        'partAnswers',
        // The objections it must answer when it was challenged.
        'realObjections',
        'prevSubAnswers',
        'keepUnchallenged',
      ],
      writes: ['answer', 'openQuestions', 'rulings', 'subAnswers', 'objectionResolutions'],
      verifyBelow: 0.6,
      retries: 2,
      complexityShift: 1,
      checks: [
        { expr: 'len(answer) > 0', message: 'Write the answer.' },
        citesFindings('answer'),
        // Every sub-question is answered with evidence, or said to be open: none is skipped.
        {
          expr: 'len(subAnswers) == len(subQuestions)',
          message: 'Give exactly one subAnswers entry per sub-question, in order.',
        },
        {
          // (No backslashes in expressions: "[[]" is a literal "[".)
          expr: 'len(unmatched(subAnswers, "^S[0-9]+: (OPEN([^A-Za-z]|$)|.*[[]F[0-9]+)")) == 0',
          message:
            'Write each subAnswers entry as "S<n>: answer [F…]" citing findings, or "S<n>: OPEN — what is missing".',
        },
        {
          expr: 'subset(refs(subAnswers), ids(findings))',
          message: 'subAnswers may cite only ids that exist in findings.',
        },
        {
          expr: 'len(rulings) == len(hypotheses)',
          message:
            'Give exactly one ruling per hypothesis: "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence".',
        },
        // Every REAL objection is met, by its tag: mentioned is not enough, it needs a verdict.
        {
          expr: 'heads(objectionResolutions, "^S[0-9]+") == heads(realObjections, "^S[0-9]+")',
          message:
            "Give exactly one objectionResolutions entry per entry of realObjections, in the same order, each starting with that objection's S tag (none when realObjections is empty).",
        },
        {
          expr: 'len(unmatched(objectionResolutions, "^S[0-9]+: (OPEN([^A-Za-z]|$)|(RESOLVED|REBUTTED)([^A-Za-z]).*[[]F[0-9]+)")) == 0',
          message:
            'Write each objectionResolutions entry as "S<n>: RESOLVED — how [F…]", "S<n>: REBUTTED — why [F…]" (citing findings) or "S<n>: OPEN — what is missing".',
        },
        {
          expr: 'subset(refs(objectionResolutions), ids(findings))',
          message: 'objectionResolutions may cite only ids that exist in findings.',
        },
        {
          // keepUnchallenged (off by default, for an A/B): a rewrite after a challenge leaves
          // alone what no REAL objection named, so it opens no new front for the next skeptic.
          expr: `if(keepUnchallenged && len(prevSubAnswers) > 0 && !includes(${TAGS('realObjections')}, "S0"), subset(pick(prevSubAnswers, outside(${TAGS('prevSubAnswers')}, ${TAGS('realObjections')})), subAnswers), true)`,
          message:
            'Keep every subAnswers entry that no entry of realObjections names (by its S tag) word for word as it was in prevSubAnswers; change only the challenged ones.',
        },
      ],
    },
    {
      id: 'listOpen',
      kind: 'compute',
      label: 'List open questions',
      // The engine, not the AI, guarantees every remaining gap is reported verbatim.
      assign: [
        {
          field: 'openQuestions',
          // Sub-questions the answer says are open are open questions, word for word.
          expr: `unique(gaps + openQuestions + unresolvedObjections + ${OPEN_ENTRIES('subAnswers')} + ${OPEN_ENTRIES('objectionResolutions')})`,
        },
        // What a rewrite after a challenge is compared with (keepUnchallenged).
        { field: 'prevSubAnswers', expr: 'subAnswers' },
      ],
    },
    ...hypotheses.nodes,
    {
      id: 'leads',
      kind: 'compute',
      label: 'Hypotheses for the readers',
      assign: [
        { field: 'leadHypotheses', expr: 'if(readerHypotheses, hypotheses, [])' },
        { field: 'leadStatus', expr: 'if(readerHypotheses, hypothesisStatus, [])' },
      ],
    },
    ...challenge.nodes,
    {
      id: 'attachParts',
      kind: 'compute',
      label: 'Finish the answer',
      // The engine, not the AI, puts every part in the result, after the (challenged) summary,
      // and every objection still open at the debate cap among the open questions.
      assign: [
        { field: 'openQuestions', expr: 'unique(openQuestions + unresolvedObjections)' },
        {
          field: 'citedFindings',
          // Whatever the answer rests on, wherever it cites it: summary, parts, sub-answers, resolutions.
          expr: 'withIds(findings, refs(answer + " " + join(partAnswers + subAnswers + objectionResolutions, " ")))',
        },
        { field: 'factsToKeep', expr: 'citedFindings' },
        {
          field: 'answer',
          expr: `if(len(partAnswers) > 0, answer + "\n\n---\n\n" + join(partAnswers, "\n\n"), answer) + "\n\n" + ${COVERAGE}`,
        },
      ],
    },
    {
      id: 'useJudge',
      kind: 'condition',
      label: 'Support judge?',
      expression: 'supportJudge != "off" && len(citedFindings) > 0',
    },
    {
      id: 'takeJudgeItems',
      kind: 'compute',
      label: 'What the judge can check',
      // Workspace citations carry a checked quote; web and other sources do not (uncheckable).
      assign: [
        {
          field: 'judgeItems',
          expr: `pick(citedFindings, positions(citedFindings, "${FILE_CITE}"))`,
        },
      ],
    },
    {
      id: 'hasJudgeItems',
      kind: 'condition',
      label: 'Any to judge?',
      expression: 'len(judgeItems) > 0',
    },
    {
      id: 'judgeSupport',
      kind: 'agent',
      role: 'assessor',
      label: 'Support judge',
      // Isolated and on another family: it sees each quote and its claim, never the question or
      // the answer, so it judges support, not plausibility.
      isolated: true,
      otherModel: true,
      directive:
        'For EVERY entry of `judgeItems`, in order, write one `supportRulings` entry: "F<n>: SUPPORTED — <why>" if the quoted text (in backticks), read as it stands, states what the claim says, or "F<n>: UNSUPPORTED — <why>" if it does not: it only mentions the subject, says something else, needs a step it does not show, or the claim adds a number, name or condition the quote lacks. Judge each one on its own quote and claim only; be strict, a quote that is merely near the claim is UNSUPPORTED. Start each entry with the id of its finding and nothing before it.',
      reads: ['judgeItems'],
      writes: ['supportRulings'],
      fanOut: { over: 'judgeItems', per: 'judgeBatch', agents: 'agents' },
      retries: 2,
      maxVisits: 1,
      checks: [
        {
          // By the id each ruling starts with, in order: an id named inside a reason does not count.
          expr: 'heads(supportRulings, "^F[0-9]+") == ids(judgeItems)',
          message:
            "Give exactly one supportRulings entry per entry of judgeItems, in the same order, each starting with that finding's id.",
        },
        {
          expr: 'len(unmatched(supportRulings, "^F[0-9]+: (SUPPORTED|UNSUPPORTED)( |$)")) == 0',
          message: 'Write each entry as "F<n>: SUPPORTED — why" or "F<n>: UNSUPPORTED — why".',
        },
      ],
    },
    {
      id: 'splitRulings',
      kind: 'compute',
      label: 'Record the rulings',
      assign: [
        {
          field: 'unsupportedIds',
          expr: 'heads(without(supportRulings, unmatched(supportRulings, "^F[0-9]+: UNSUPPORTED")), "^F[0-9]+")',
        },
        // What later runs remember: never a finding whose quote does not back its claim.
        {
          field: 'factsToKeep',
          expr: 'without(citedFindings, withIds(citedFindings, unsupportedIds))',
        },
        {
          field: 'doubts',
          expr: `doubts + if(len(unsupportedIds) > 0, ["The support judge found these cited findings unsupported by their own quotes" + if(supportJudge == "shadow", " (shadow mode: reported, the outcome unchanged)", "") + ": " + join(without(supportRulings, unmatched(supportRulings, "^F[0-9]+: UNSUPPORTED")), "; ")], []) + if(len(citedFindings) > len(judgeItems), [text(len(citedFindings) - len(judgeItems)) + " cited findings cite web pages or other sources: the support judge cannot check them"], [])`,
        },
      ],
    },
    {
      id: 'settled',
      kind: 'condition',
      label: 'Settled?',
      // Open objections, open sub-questions or low confidence are said in the outcome, not only
      // in the text. Confidence is the assessor's (from before any debate), so it is not enough.
      expression: `(supportJudge != "enforce" || len(unsupportedIds) == 0) && len(unresolvedObjections) == 0 && len(${OPEN_ENTRIES('subAnswers')}) == 0 && len(${OPEN_ENTRIES('objectionResolutions')}) == 0 && confidence >= 0.5`,
    },
    {
      id: 'noteDoubts',
      kind: 'compute',
      label: 'Say why it is unsettled',
      assign: [
        {
          field: 'doubts',
          expr: `doubts + if(len(unresolvedObjections) > 0, ["Objections were still open when the debate reached its cap (maxDebateRounds): see unresolvedObjections"], []) + if(len(${OPEN_ENTRIES('subAnswers')}) > 0, ["Sub-questions the findings do not answer: " + join(${OPEN_ENTRIES('subAnswers')}, "; ")], []) + if(len(${OPEN_ENTRIES('objectionResolutions')}) > 0, ["Objections the answer could not settle: " + join(${OPEN_ENTRIES('objectionResolutions')}, "; ")], []) + if(confidence < 0.5, ["Confidence that the findings answer the question stayed below 0.5"], [])`,
        },
      ],
    },
    // Only a settled answer teaches: what was asked and how it ended, a lead for later questions
    // like it, stale once its cited files change. An unsettled one leaves no lesson.
    // Only one that names a workspace file: a file-less lesson cannot go stale with the code.
    rememberLessonNode('learnAnswer', 'answered', LESSON_INPUTS, {
      outcome: 'success',
      requireFiles: true,
    }),
    // The facts later runs get are the ones this answer used, not everything read on the way.
    rememberCitedNode('rememberCited', 'factsToKeep'),
    { id: 'done', kind: 'end', label: 'Answered', outcome: 'success' },
    { id: 'doubts', kind: 'end', label: 'Answered, with open doubts', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-recall', from: 'start', to: 'recall' },
    { id: 'recall-catalog', from: 'recall', to: 'catalog' },
    { id: 'catalog-plan', from: 'catalog', to: 'plan' },
    { id: 'plan-recall', from: 'plan', to: 'recallPlan' },
    { id: 'recallPlan-merge', from: 'recallPlan', to: 'mergeRecall' },
    { id: 'mergeRecall-queue', from: 'mergeRecall', to: 'queue' },
    { id: 'queue-hypothesize', from: 'queue', to: hypotheses.entry },
    ...hypotheses.edges,
    { id: 'rating-leads', from: hypotheses.exit!, to: 'leads' },
    { id: 'leads-needFiles', from: 'leads', to: 'needFiles' },
    { id: 'needFiles-inventory', from: 'needFiles', to: 'inventory', branch: 'then' },
    { id: 'needFiles-needWeb', from: 'needFiles', to: 'needWeb', branch: 'else' },
    { id: 'inventory-rank', from: 'inventory', to: 'rankFiles' },
    { id: 'rank-count', from: 'rankFiles', to: 'countFiles' },
    { id: 'count-small', from: 'countFiles', to: 'smallRepo' },
    { id: 'small-queueFiles', from: 'smallRepo', to: 'queueFiles', branch: 'then' },
    { id: 'small-locate', from: 'smallRepo', to: 'locate', branch: 'else', label: 'big repo' },
    { id: 'locate-queueScope', from: 'locate', to: 'queueScope' },
    { id: 'queueFiles-needWeb', from: 'queueFiles', to: 'needWeb' },
    { id: 'queueScope-needWeb', from: 'queueScope', to: 'needWeb' },
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
    { id: 'takeBatch-pass', from: 'takeBatch', to: 'singlePassOn' },
    { id: 'pass-deep', from: 'singlePassOn', to: 'triageDeep', branch: 'then', label: 'pilot' },
    { id: 'pass-triage', from: 'singlePassOn', to: 'triage', branch: 'else' },
    { id: 'triage-checkTriage', from: 'triage', to: 'checkTriage' },
    { id: 'triageDeep-checkTriage', from: 'triageDeep', to: 'checkTriage' },
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
    { id: 'retryUnread-expandDone', from: 'retryUnread', to: 'expandDone', branch: 'else' },
    { id: 'expandDone-endExpand', from: 'expandDone', to: 'endExpand', branch: 'then' },
    { id: 'expandDone-hasExperiments', from: 'expandDone', to: 'hasExperiments', branch: 'else' },
    { id: 'endExpand-assess', from: 'endExpand', to: 'assess', label: 're-assess' },
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
    { id: 'queueExperiments-parallel', from: 'queueExperiments', to: 'hasParallel' },
    { id: 'hasParallel-run', from: 'hasParallel', to: 'parallelExperiment', branch: 'then' },
    { id: 'hasParallel-left', from: 'hasParallel', to: 'experimentsLeft', branch: 'else' },
    { id: 'parallel-check', from: 'parallelExperiment', to: 'checkParallel' },
    { id: 'checkParallel-merge', from: 'checkParallel', to: 'mergeParallel' },
    { id: 'mergeParallel-left', from: 'mergeParallel', to: 'experimentsLeft' },
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
    { id: 'assess-recordGaps', from: 'assess', to: 'recordGaps' },
    { id: 'recordGaps-expandGaps', from: 'recordGaps', to: 'expandGaps' },
    { id: 'expandGaps-pool', from: 'expandGaps', to: 'expandPoolOf', branch: 'then' },
    { id: 'expandGaps-moreGaps', from: 'expandGaps', to: 'moreGaps', branch: 'else' },
    { id: 'pool-rankGaps', from: 'expandPoolOf', to: 'rankGaps' },
    { id: 'rankGaps-takeExpand', from: 'rankGaps', to: 'takeExpand' },
    { id: 'takeExpand-expanded', from: 'takeExpand', to: 'expanded' },
    { id: 'expanded-deepLeft', from: 'expanded', to: 'deepLeft', branch: 'then', label: 'read' },
    { id: 'expanded-moreGaps', from: 'expanded', to: 'moreGaps', branch: 'else' },
    { id: 'moreGaps-aimChase', from: 'moreGaps', to: 'aimChase', branch: 'then' },
    { id: 'aimChase-chase', from: 'aimChase', to: 'chase' },
    { id: 'moreGaps-confident', from: 'moreGaps', to: 'confident', branch: 'else' },
    { id: 'chase-checkChase', from: 'chase', to: 'checkChase' },
    { id: 'checkChase-mergeChase', from: 'checkChase', to: 'mergeChase' },
    { id: 'mergeChase-assess', from: 'mergeChase', to: 'assess', label: 're-assess' },
    { id: 'confident-multiPart', from: 'confident', to: 'multiPart', branch: 'then' },
    { id: 'confident-clarify', from: 'confident', to: 'clarify', branch: 'else' },
    { id: 'clarify-useHint', from: 'clarify', to: 'useHint', branch: 'approved' },
    { id: 'clarify-multiPart', from: 'clarify', to: 'multiPart', branch: 'rejected' },
    { id: 'multiPart-answerParts', from: 'multiPart', to: 'answerParts', branch: 'then' },
    { id: 'multiPart-answer', from: 'multiPart', to: 'answer', branch: 'else' },
    { id: 'answerParts-answer', from: 'answerParts', to: 'answer' },
    // A hint you gave always gets its round of research (counted in chaseRounds).
    { id: 'useHint-aimChase', from: 'useHint', to: 'aimChase' },
    { id: 'answer-listOpen', from: 'answer', to: 'listOpen' },
    { id: 'listOpen-challenge', from: 'listOpen', to: challenge.entry },
    ...challenge.edges,
    { id: 'attachParts-useJudge', from: 'attachParts', to: 'useJudge' },
    { id: 'useJudge-take', from: 'useJudge', to: 'takeJudgeItems', branch: 'then' },
    { id: 'useJudge-settled', from: 'useJudge', to: 'settled', branch: 'else' },
    { id: 'take-hasItems', from: 'takeJudgeItems', to: 'hasJudgeItems' },
    { id: 'hasItems-judge', from: 'hasJudgeItems', to: 'judgeSupport', branch: 'then' },
    { id: 'hasItems-split', from: 'hasJudgeItems', to: 'splitRulings', branch: 'else' },
    { id: 'judge-split', from: 'judgeSupport', to: 'splitRulings' },
    { id: 'split-settled', from: 'splitRulings', to: 'settled' },
    { id: 'settled-learn', from: 'settled', to: 'learnAnswer', branch: 'then' },
    { id: 'settled-note', from: 'settled', to: 'noteDoubts', branch: 'else' },
    { id: 'learn-cited', from: 'learnAnswer', to: 'rememberCited' },
    { id: 'cited-done', from: 'rememberCited', to: 'done' },
    { id: 'note-doubts', from: 'noteDoubts', to: 'doubts' },
  ],
  demo: {
    context: { question: 'Where are AI responses validated before they change state, and why?' },
    tools: {
      recall: () => ({ facts: [], lessons: [] }),
      learnAnswer: () => ({ saved: true }),
      rememberCited: (s) => ({ saved: ((s.citedFindings as string[]) ?? []).length }),
      ...Object.fromEntries(
        [
          'checkTriage',
          'checkDeep',
          'checkParallel',
          'checkExperiment',
          'checkSource',
          'checkChase',
          'checkSecond',
        ].map((id) => [
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
      rankFiles: (s) => {
        const files = (s.repoFiles as string[]) ?? [];
        const hit = files.filter((f) => RELEVANT.test(f));
        return { ranked: [...hit, ...files.filter((f) => !hit.includes(f))], matched: hit };
      },
      // The gap names the command line: the CLI shares its words.
      rankGaps: (s) => {
        const pool = (s.expandPool as string[]) ?? [];
        const hit = pool.filter((f) => f.endsWith('cli.ts'));
        return { ranked: [...hit, ...pool.filter((f) => !hit.includes(f))], matched: hit };
      },
    },
    agents: {
      locate: () => ({
        updates: {
          scopeFiles: ['src/core/engine.ts', 'src/core/schema.ts', 'src/core/validate.ts'],
          scopeReasons: [
            'git grep "validat" found the engine checking moves',
            'git grep "validat" found the answer schema',
            'git grep "validat" found the pattern validator',
          ],
          scopeQueries: ['git grep -n "validat"', 'git log --oneline -- src/core'],
        },
        verdict: v('located'),
      }),
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
            parts: [],
            // The demo keeps the number of sub-agents it was given (4 by default).
            agents: typeof s.agents === 'number' ? s.agents : MAX_AGENTS,
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
          timedExperiments: [],
        },
        verdict: v('designed'),
      }),
      parallelExperiment: () => ({
        updates: {
          queries: ['npm test -- src/core/engine.test.ts'],
          newFindings: ['experiment | npm test — 0 state changes after an invalid answer (3 runs)'],
        },
        verdict: v('ran'),
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
      triageDeep: (s) => {
        const batch = (s.batch as string[]) ?? [];
        const relevant = batch.filter((f) => RELEVANT.test(f));
        return {
          updates: {
            triaged: batch,
            batchRelevant: relevant,
            readFully: relevant,
            newFindings: relevant.map((f) => `${f}:1 — read in depth at triage`),
          },
          verdict: v(`triaged and read ${relevant.length} of ${batch.length} files`),
        };
      },
      deepRead: (s) => {
        const batch = (s.deepBatch as string[]) ?? [];
        return {
          updates: {
            examined: batch,
            unreadable: [],
            unreadableReasons: [],
            readNotes: batch.map((f) => `${f} — read in full`),
            newFindings: batch.map((f) =>
              f.startsWith('http')
                ? `${f} — state machines apply transitions only on valid input`
                : f.endsWith('schema.ts')
                  ? `${f}:115 — validateNodeResult checks verdict and typed updates${tagged(s, ' [H1 for, H3 against]')}`
                  : `${itemOf(f).path}:${itemOf(f).from ?? 1} — reviewed fully`,
            ),
          },
          verdict: v('read fully'),
        };
      },
      sweep: (s) => ({
        updates: {
          queries: [
            `${String((s.currentSources as string[])[0])}: ${((s.searchTerms as string[]) ?? [])[0] ?? 'question'}`,
          ],
          newFindings: [
            `${String((s.currentSources as string[])[0])} | search — consistent with validate-before-apply design`,
          ],
        },
        verdict: v('searched'),
      }),
      assess: (s, visit) =>
        visit < 2
          ? {
              updates: {
                ...assessFor(s, [((s.subQuestions as string[]) ?? [])[1] ?? ''].filter(Boolean)),
                confidence: 0.6,
              },
              verdict: v('one gap', 0.6),
            }
          : { updates: { ...assessFor(s, []), confidence: 0.9 }, verdict: v('covered') },
      chase: (s) => ({
        updates: {
          queries: ['git log -S validateNodeResult'],
          newFindings: [
            `git-history | commit "feat(core): score/performance types and response validation" — validation added with the engine${tagged(s, ' [H2 against]')}`,
          ],
        },
        verdict: v('gap closed'),
      }),
      answerParts: (s) => ({
        updates: {
          partAnswers: ((s.parts as string[]) ?? []).map(
            (part) => `## ${part}\n\nWhat the evidence shows about ${part} [F1].`,
          ),
        },
        verdict: v('answered each part'),
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
          ].join('\n'),
          openQuestions: (s.gaps as string[]) ?? [],
          // One per sub-question: answered with a citation, or open when it is still a gap.
          subAnswers: ((s.subQuestions as string[]) ?? []).map((q, i) =>
            ((s.gaps as string[]) ?? []).includes(q)
              ? `S${i + 1}: OPEN — ${q} is not settled by the findings`
              : `S${i + 1}: answered by the validation path [F1]`,
          ),
          rulings: ((s.hypotheses as string[]) ?? []).map((h, i) =>
            i === 0
              ? `${h.split(':')[0]}: CONFIRMED — src/core/engine.ts resolveAgent validates before applying`
              : `${h.split(':')[0]}: REFUTED — no state change happens outside advance()`,
          ),
          objectionResolutions: ((s.realObjections as string[]) ?? []).map(
            (o) => `${o.split(':')[0]}: RESOLVED — the move key is the same after a rejection [F1]`,
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
      judgeSupport: (s) => ({
        updates: {
          supportRulings: ((s.judgeItems as string[]) ?? []).map(
            (f) => `${f.split(' ')[0]}: SUPPORTED — the quote states it`,
          ),
        },
        verdict: v('judged'),
      }),
      challenge: (_s, visit) => ({
        updates: {
          objections:
            visit === 0
              ? [
                  'S2: "a rejected answer keeps the same move key" has no finding behind it: check moveKeyOf in src/core/engine.ts',
                ]
              : [],
        },
        verdict: v(visit === 0 ? 'one unsupported claim' : 'the answer stands'),
      }),
      triageObjections: (s) => ({
        updates: {
          objectionTriage: ((s.objections as string[]) ?? []).map(
            (o) => `${o.slice(0, 40)}…: REAL — no finding backs this claim, and it would change S2`,
          ),
          realObjections: (s.objections as string[]) ?? [],
        },
        verdict: v('triaged'),
      }),
      second: () => ({
        updates: {
          secondOpinion:
            'The engine validates (src/core/engine.ts resolveAgent → checkAgentResult). H1 confirmed; H2 and H3 refuted.',
          newFindings: [
            'src/core/engine.ts:1 — resolveAgent checks the answer before applying it [H1 for, H3 against]',
          ],
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
