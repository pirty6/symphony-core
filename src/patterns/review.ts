import { MAX_AGENTS, type Pattern, type ScoreNode } from '../core/types.js';
import { TEST_PATH } from './phases/stability.js';
import { bullets, READER_STATE, readers } from './phases/readers.js';
import { chaseSteps } from './phases/chase.js';
import { DEBATE_STATE, MAX_OBJECTIONS } from './phases/debate.js';
import {
  checkFindings,
  CITE_BY_ID,
  citesFindings,
  EVIDENCE_STATE,
  MEMORY_NOTE,
  MEMORY_STATE,
  recallMemory,
} from './phases/evidence.js';
import {
  attest,
  ATTESTATION_DIRECTIVE,
  attestationChecks,
  CATEGORIES,
  categoryBullets,
  findingChecks,
  orFailed,
} from './phases/reviewRules.js';

/**
 * The review for an AI agent (the engine writes it from the record): what was reviewed, how
 * it ended, what to do, the verified findings, what is not settled, what not to rely on, the
 * verdicts per claim, behaviour and required change, the checks and the coverage.
 */
const REVIEW_HANDOFF = [
  '"# Code review brief for an AI agent\n\nRead all of it before you act. Each finding cites the code as path:line with a quote, and has an id like F3. The most important comes first.\n\n## Task\n\nReview of: " + target',
  'if(empty(hint), "", "\nFocus asked for: " + hint)',
  'if(empty(intent), "", "\nWhat the change is for: " + intent)',
  '"\n\n## Status\n\n" + if(reviewStatus == "issues", "Issues found: see Findings.", if(reviewStatus == "issuesOpen", "Issues found, and some things are not settled: see Findings and Not settled.", if(reviewStatus == "notVerified", "Not verified: the findings\' quotes are not in this checkout, so nothing could be confirmed.", if(reviewStatus == "partlyReviewed", "Reviewed in part: see Coverage for what was not reviewed or not checked.", if(reviewStatus == "openQuestions", "No issue found, but some things are not settled: see Not settled.", "Looks good: every changed file was reviewed, every claim, behaviour and required change checked, and no issue found.")))))',
  '"\nTests and lint: not run by a review (the change\'s CI runs them)."',
  '"\n\n## Instructions for the next agent\n\n- Fix the findings HIGH first. Before you change a line, read it again: the code may have changed since this review.\n- Run the tests after each change; a failing test the review reported must pass.\n- Settle the Not settled entries before you call the change done.\n- Do not act on Dismissed or Do not rely on entries: use them only as leads to check.\n- Files the coverage lists as not reviewed are not known to be good: review them before you rely on them."',
  `"\n\n## Findings (checked against the code)\n\n" + ${bullets('findings')}`,
  `"\n\n## Review comments: what is wrong, an example, why it matters, how to fix\n\n" + if(len(comments) == 0, "none", join(comments, "\n\n"))`,
  `"\n\n## Not settled\n\n" + ${bullets('openItems + adverseVerdicts')}`,
  `"\n\n## Dismissed by the skeptic\n\n" + ${bullets('dismissals')}`,
  `"\n\n## Do not rely on: findings that could not be verified\n\n" + ${bullets('unverified')}`,
  '"\n\n## What the change says it does\n\n" + if(empty(claims), "not stated", claims)',
  `"\n\n## Claims, one by one\n\n" + ${bullets('claimVerdicts')}`,
  `"\n\n## Changed behaviour and its tests\n\n" + ${bullets('testVerdicts')}`,
  `"\n\n## Changes this one requires\n\n" + ${bullets('obligationVerdicts')}`,
  `"\n\n## Facts found while settling open points\n\n" + ${bullets('evidence')}`,
  `"\n\n## Engine scan of the diff (leads, not findings)\n\n" + ${bullets('smellHints + maskingFlags')}`,
  `"\n\n## What the reviewers examined\n\n" + ${bullets('attestations')}`,
  '"\n\n## Coverage\n\n" + if(empty(coverage), "Every changed file was reviewed.", coverage)',
  '"\n\n## The review as written\n\n" + report',
].join(' + ');

const READERS = readers({
  handoff: REVIEW_HANDOFF,
  about: 'the review of `target`: whether the change is safe to merge, and what to fix',
  sources: [
    'report',
    'findings',
    'comments',
    'openItems',
    'adverseVerdicts',
    'dismissals',
    'coverage',
    'claims',
    'unverified',
  ],
  ends: [
    { id: 'issues', label: 'Issues reported' },
    { id: 'issuesOpen', label: 'Issues reported, not all settled' },
    { id: 'notVerified', label: 'Could not verify' },
    { id: 'partlyReviewed', label: 'Reviewed in part' },
    { id: 'openQuestions', label: 'Not settled' },
    { id: 'clean', label: 'Looks good' },
  ],
  status: 'reviewStatus',
  locations: 'findings',
});

/** The id an inventory or verdict entry starts with: "B1 …" is B1. */
const idOf = (entry: string) => entry.split(' ')[0]!;

const v = (reason: string) => ({
  outcome: 'applied' as const,
  confidence: 0.9,
  shouldTerminate: false,
  reason,
});

/** The changed file a context entry is for: "(for: src/a.ts)" gives src/a.ts. */
const FOR_FILE = '(?<=[(]for: )[^)]+';
/** A finding's place and category: "src/a.ts:3 — [BUG]". */
const PLACE = '^[^ ]+:[0-9]+(-[0-9]+)? — [[][A-Z]+]';
/** A finding's severity tag, for the skeptic's downgrades. */
const SEVERITY = '[[](HIGH|MEDIUM|LOW)]';
/** Files that are only documentation: no test needs to run for them. */
const DOC_FILE = '[.](md|mdx|txt|rst|adoc)$';
/**
 * Files nothing needs comparing with: documentation, and release-note change files (beachball's
 * change/*.json; changesets are Markdown). Seen live: a review stopped because the AI kept
 * leaving out context for a change/*.json among 19 files.
 */
const NO_CONTEXT_FILE = `${DOC_FILE}|^change/[^/]+[.]json$`;

/** A review comment: the finding's id, then each part, in order (`[^]` spans lines). */
const COMMENT_SHAPE =
  '^F[0-9]+ [^]*What is wrong: [^]*Example: [^]*Why it matters: [^]*How to fix: ';

/** How a comment explains a finding so that anyone can understand it and act on it. */
const COMMENT_DIRECTIVE = `For each finding of \`findings\`, in order, write one \`comments\` entry that someone new to this codebase can understand and act on. Read the code it cites, and what calls it, first (read-only). Use this shape, with Markdown code blocks for code:

F<n> <the problem in a few words>
What is wrong: what the code does, in plain words, at path:line.
Example: make it concrete.
- A pattern, regex, parser, boundary or logic bug: 2 or 3 inputs, what the code gives today and what it should give, e.g. \`[0-9]+\` on "12a": matches today (it finds "12"), expected: no match, since the whole value must be a number; on "7": matches, as expected. Fix: \`^[0-9]+$\`.
- A missing or weak test: the test that is missing, as code.
- A design, Clean Code or naming issue: the current code, then the suggested code.
- A missing change: what must change, and where.
Why it matters: who or what breaks, when, and how badly (why the severity).
How to fix: the smallest correct change (a short code snippet when it fits in a few lines), and the test that would catch it.

Work each example out from the code; never claim you ran it. Plain words, short sentences; name things by their name in the code.`;

/**
 * Record checked issues with ids. Unlike investigate's findings, a review's can be dismissed, so
 * ids go on from every one made (kept or dismissed: never reused), and one already dismissed is
 * not recorded again.
 */
const mergeIssues = (field: string) => [
  {
    field: 'findings',
    expr: `findings + numbered(without(unique(${field}), unnumbered(findings) + unnumbered(dismissed)), len(findings) + len(dismissed) + 1)`,
  },
  { field: 'unverified', expr: 'unverified + rejectedFindings' },
  { field: 'findingsBrief', expr: 'brief(findings, 240)' },
];

/** What an objection attacks: a verdict by its id (C2, B1, O3), or a missed issue at path:line. */
const OBJECTION_TARGET = '(^|[^A-Za-z0-9])[CBO][0-9]+([^0-9]|$)|[^ :]+:[0-9]+';

/** Investigate's gap research (phases/chase), aimed at what the review could not settle. */
const REVIEW_CHASE = chaseSteps({
  ids: { chase: 'chase', check: 'checkChase', merge: 'mergeChase' },
  label: 'Settle open points',
  mergeLabel: 'Record what was found',
  directive: `Settle each entry of \`chaseItems\` (a claim the review could not settle, or a reviewer's objection to the review) by reading the change (git diff \`diffRange\`, or git diff HEAD when it is empty) and the code around it: its callers, tests and docs (read-only). Record every command or read in \`queries\`, and every fact you find, for or against, as "path:line — fact \`exact quote\`" in \`chaseNotes\`. If nothing settles an entry, add a note saying where you looked.${MEMORY_NOTE}`,
  reads: [
    'target',
    'intent',
    'claims',
    'claimList',
    'chaseItems',
    'diffRange',
    'diff',
    'findingsBrief',
    'context',
    'evidence',
    'knownFacts',
  ],
  notes: 'chaseNotes',
  bound: { maxVisits: 4, visitsFrom: 'maxChaseRounds + maxDebateRounds' },
  merge: [
    // Facts, not issues: they settle verdicts, and a fact that did not check is left out.
    { field: 'evidence', expr: 'unique(evidence + chaseNotes)' },
    { field: 'chaseRounds', expr: 'chaseRounds + 1' },
    { field: 'objectionGaps', expr: '[]' },
  ],
});

/** An evidence.check of an inventory: what fails goes to its own list, not lost. */
const checkInventory = (id: string, field: string, rejected: string): ScoreNode => ({
  id,
  kind: 'tool',
  label: `Check ${field}`,
  tool: 'evidence.check',
  args: { remember: false },
  inputs: { findings: field },
  output: { valid: field, invalid: rejected },
});

/** "C1 …", "C2 …": an inventory numbered in order, each entry well-formed. */
const numberedList = (field: string, tag: string, shape: string, message: string) =>
  orFailed({
    expr: `len(unmatched(${field}, "^${tag}[0-9]+ ${shape}")) == 0 && heads(${field}, "^${tag}[0-9]+") == seq("${tag}", len(${field}))`,
    message,
  });

/** One verdict per inventory entry, by id and in order: an omitted or doubled entry fails. */
const verdictPerEntry = (verdicts: string, inventory: string, tag: string, words: string) =>
  orFailed({
    expr: `len(unmatched(${verdicts}, "^${tag}[0-9]+ (${words}) — ")) == 0 && heads(${verdicts}, "^${tag}[0-9]+ ") == heads(${inventory}, "^${tag}[0-9]+ ")`,
    message: `Write one ${verdicts} entry for each entry of ${inventory}, with its id, in order: "${tag}<n> ${words.split('|').join('|')} — …".`,
  });

/** Each adverse verdict is also a finding of its category (here or already in findings). */
const adverseIsFinding = (adverse: string, category: string, what: string) =>
  orFailed({
    expr: `${adverse} <= count(wholeFindings + findings, " — [[]${category}] ")`,
    message: `Write each ${what} as a [${category}] finding in wholeFindings too (unless findings already has it).`,
  });

/**
 * Review of a branch or PR. The changed files are listed (what was left out, and why, is
 * recorded) and the engine scans the diff for smells and test masking. One step gathers the
 * whole change's context first: what it claims, the conventions and similar code to compare it
 * with, the behaviours it changes and the other changes it requires. The files are then reviewed
 * in parallel parts, each attesting what it examined per dimension; one step judges the whole
 * change (each claim, each behaviour's tests, each required change, scope and approach); and a
 * skeptic on another model keeps, downgrades or drops each finding. Every finding cites the code
 * and is checked before it counts. It ends "Looks good" only when everything was read and
 * settled: anything not settled, not verified or not read ends partial.
 */
export const review: Pattern = {
  name: 'review',
  description:
    'Review a branch or PR: correctness and approach, fit with similar code, scope, Clean Code (rule ids), pitfalls (security, performance, concurrency, error paths, compatibility), missing code and missing tests; each claim, behaviour and required change gets a verdict; a skeptic challenges the findings; every issue is cited and checked.',
  verbTriggers: ['review', 'audit', 'check my changes'],
  requiredContext: ['target'],
  goalFrom: 'target',
  // A PR link or number: the runtime checks the PR out apart and the review plays on its code.
  checkout: 'target',
  // People first (plain, short), then an AI agent (the findings, checks and coverage, with
  // instructions): a chained fix gets the brief whole.
  result: ['summary', 'handoff'],
  maxSteps: 200,
  state: [
    {
      name: 'target',
      type: 'string',
      description:
        'Branch, commit range or PR to review (its code must be checked out here: citations are checked against this workspace)',
    },
    { name: 'hint', type: 'string', description: 'Optional: what to focus on' },
    {
      name: 'intent',
      type: 'string',
      description:
        'Optional: what the change is for (the linked issue or its acceptance criteria): each part becomes a claim to check',
    },
    {
      name: 'complexity',
      type: 'number',
      description: '1 to 4 (0: auto); the skeptic challenges the findings from 2',
    },
    { name: 'prNumber', type: 'number', description: 'The PR checked out here (0: none)' },
    {
      name: 'prBase',
      type: 'string',
      description: 'The commit the PR merges into: `git diff <prBase> HEAD` is the PR',
    },
    { name: 'prFiles', type: 'string[]', description: 'The PR\'s changed files, "M\tpath"' },
    { name: 'prPaths', type: 'string[]', description: "The PR's changed paths" },
    { name: 'prError', type: 'string', description: 'Why the PR could not be fetched' },
    { name: 'diffSummary', type: 'string', description: 'What changed, per file' },
    {
      name: 'diffRange',
      type: 'string',
      description: 'The git range of the change, e.g. "main...HEAD" ("": uncommitted changes)',
    },
    { name: 'diff', type: 'string', description: 'The whole diff, cut at 30,000 characters' },
    { name: 'diffError', type: 'string', description: 'Why the diff could not be scanned' },
    {
      name: 'smellHints',
      type: 'string[]',
      description: 'The engine scan: smells in added lines (leads, not findings)',
    },
    {
      name: 'maskingFlags',
      type: 'string[]',
      description: 'The engine scan: test changes that may hide a failure (leads)',
    },
    {
      name: 'claims',
      type: 'string',
      description: 'What the change says it does (PR description, commit messages)',
    },
    { name: 'files', type: 'string[]', description: 'Changed files to review (paths)' },
    {
      name: 'deleted',
      type: 'string[]',
      description: 'Changed files the change deletes (paths): nothing left to read',
    },
    {
      name: 'skipped',
      type: 'string[]',
      description: 'Changed files left out, each with why: "path — lockfile"',
    },
    {
      name: 'maxFiles',
      type: 'number',
      initial: 60,
      min: 1,
      description:
        'Most files reviewed (cost grows with each); the rest are listed as not reviewed',
    },
    {
      name: 'overflow',
      type: 'string[]',
      description: 'Changed files over maxFiles, not reviewed',
    },
    { name: 'changedTests', type: 'string[]', description: 'Changed files that are tests' },
    {
      name: 'agents',
      type: 'number',
      initial: 3,
      description: `Parallel reviewers (1 to ${MAX_AGENTS}), chosen from the size of the diff`,
    },
    { name: 'filesPerAgent', type: 'number', initial: 3 },
    {
      name: 'claimList',
      type: 'string[]',
      description: 'What the change claims to do (and intent asks for), one per entry: "C1 …"',
    },
    {
      name: 'context',
      type: 'string[]',
      description:
        'What to compare the change with: "path:line — [CONVENTION|SIMILAR|CALLER] why `quote`"',
    },
    {
      name: 'behaviours',
      type: 'string[]',
      description: 'Behaviour the change adds or changes: "B1 path:line — behaviour `quote`"',
    },
    {
      name: 'obligations',
      type: 'string[]',
      description:
        'Other changes this one requires: "O1 [CALLER|MIGRATION|CONFIG|DOCS|ERRPATH] path:line — what must exist `quote`"',
    },
    { name: 'rejectedContext', type: 'string[]' },
    { name: 'rejectedBehaviours', type: 'string[]' },
    { name: 'rejectedObligations', type: 'string[]' },
    {
      name: 'inventoryRejected',
      type: 'string[]',
      description: 'Context, behaviours and required changes whose citation did not hold',
    },
    { name: 'reviewed', type: 'string[]', description: 'Files whose changes were read' },
    {
      name: 'attestations',
      type: 'string[]',
      description: 'What each reviewer examined, per dimension: "D5 PITFALLS: NONE — …"',
    },
    {
      name: 'partlyRead',
      type: 'string[]',
      description: 'Files the engine could not give whole (by the engine)',
    },
    { name: 'partlyReadReasons', type: 'string[]', description: 'Why, by position' },
    {
      name: 'newFindings',
      type: 'string[]',
      description: 'Issues found now: "path:line — [CATEGORY] [SEVERITY] problem `quote`"',
    },
    {
      name: 'wholeFindings',
      type: 'string[]',
      description: 'Issues the whole-change step found (checked and merged into findings)',
    },
    {
      name: 'claimVerdicts',
      type: 'string[]',
      description: '"C1 MET|PARTIAL|NOT MET|UNCLEAR — path:line — why", one per claim',
    },
    {
      name: 'testVerdicts',
      type: 'string[]',
      description: '"B1 TESTED|WEAK|UNTESTED|NA — test path:line, or why", one per behaviour',
    },
    {
      name: 'obligationVerdicts',
      type: 'string[]',
      description: '"O1 FOUND|ABSENT — where, or what is missing", one per required change',
    },
    { name: 'related', type: 'string[]', description: 'Files that serve what the change is for' },
    {
      name: 'unrelated',
      type: 'string[]',
      description: 'Files unrelated to what the change is for',
    },
    { name: 'findings', type: 'string[]', description: 'Checked issues, numbered F1, F2…' },
    {
      name: 'dispositions',
      type: 'string[]',
      description: 'The skeptic, per finding: "F1 KEEP|DOWNGRADE MEDIUM|DOWNGRADE LOW|DROP — why"',
    },
    { name: 'dismissed', type: 'string[]', description: 'Findings the skeptic dropped' },
    { name: 'dismissals', type: 'string[]', description: 'Why each was dropped' },
    {
      name: 'stepsFailed',
      type: 'string[]',
      description: 'Steps that answered "failed": what they check was not checked',
    },
    ...EVIDENCE_STATE,
    ...MEMORY_STATE,
    ...DEBATE_STATE.filter((f) =>
      [
        'objections',
        'objectionTriage',
        'realObjections',
        'debateRounds',
        'maxDebateRounds',
        'debateFindings',
        'unresolvedObjections',
      ].includes(f.name),
    ),
    {
      name: 'pragmatistFrom',
      type: 'number',
      // 2, not investigate's 3: seen live, an unchecked skeptic dropped the one real finding of a
      // review. It plays only when the skeptic would drop, downgrade or object, and has no tools.
      initial: 2,
      description: 'The complexity from which a pragmatist triages what the skeptic would change',
    },
    {
      name: 'pastObjections',
      type: 'string[]',
      description: 'Objections raised in earlier rounds',
    },
    { name: 'debateLog', type: 'string[]', description: 'One line per debate round' },
    {
      name: 'proposedDispositions',
      type: 'string[]',
      description: 'What the skeptic would do with each finding, before the pragmatist',
    },
    {
      name: 'chaseItems',
      type: 'string[]',
      description: 'What research is to settle: unclear claims, objections sent back',
    },
    { name: 'objectionGaps', type: 'string[]', description: 'Objections the debate sent back' },
    { name: 'chaseNotes', type: 'string[]', description: 'Facts research found this round' },
    {
      name: 'evidence',
      type: 'string[]',
      description: 'Checked facts research found on what was unclear or objected to',
    },
    { name: 'queries', type: 'string[]', description: 'What research ran or read' },
    { name: 'chaseRounds', type: 'number' },
    {
      name: 'maxChaseRounds',
      type: 'number',
      initial: 1,
      min: 0,
      description: 'Research rounds for unclear claims (objections bring their own)',
    },
    { name: 'secondReviewed', type: 'boolean' },
    {
      name: 'investigateOpen',
      type: 'boolean',
      initial: false,
      description:
        'A review that ends with something not settled hands it to investigate, which plays next',
    },
    {
      name: 'adverseVerdicts',
      type: 'string[]',
      description: 'Claims not met, behaviours not well tested, required changes absent',
    },
    {
      name: 'openItems',
      type: 'string[]',
      description: 'What is not settled (each keeps the review from ending "Looks good")',
    },
    {
      name: 'coverage',
      type: 'string',
      description: 'What was not reviewed or not checked, and why',
    },
    {
      name: 'comments',
      type: 'string[]',
      description: 'One per finding: what is wrong, an example, why it matters and how to fix it',
    },
    { name: 'report', type: 'string', description: 'The review, by severity' },
    { name: 'reviewStatus', type: 'string', description: 'The end reached (by the engine)' },
    ...READER_STATE,
  ],
  // The studio and the docs draw each as one box (open it to see its steps).
  groups: [
    {
      id: 'chasePhase',
      label: 'Settle open points',
      description: "investigate's gap research: unclear claims and objections, then judged again",
      nodes: ['aimChase', 'wantChase', 'chase', 'checkChase', 'mergeChase'],
    },
    {
      id: 'debatePhase',
      label: 'Challenge the review',
      description:
        'A second reviewer (4), the skeptic (≥2) and the pragmatist (≥pragmatistFrom), as in investigate',
      nodes: [
        'useSecond',
        'second',
        'checkSecond',
        'mergeSecond',
        'wantSkeptic',
        'skeptic',
        'skepticOk',
        'noteSkepticFailed',
        'usePragmatist',
        'pragmatist',
        'takeAll',
        'applyDispositions',
        'anyReal',
        'roundsLeft',
        'reopen',
        'keepOpen',
      ],
    },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'prInfo',
      kind: 'tool',
      label: 'Pull request',
      tool: 'git.pr',
      output: {
        number: 'prNumber',
        base: 'prBase',
        files: 'prFiles',
        paths: 'prPaths',
        error: 'prError',
      },
    },
    { id: 'prFetched', kind: 'condition', label: 'PR fetched?', expression: 'empty(prError)' },
    {
      id: 'noPr',
      kind: 'compute',
      label: 'Say why',
      assign: [{ field: 'report', expr: '"Could not review: " + prError + "."' }],
    },
    {
      id: 'collect',
      kind: 'agent',
      role: 'assessor',
      label: 'Collect diff',
      // A PR can change on GitHub, which the workspace fingerprint does not see: never replayed.
      fresh: true,
      directive: `Read the diff for \`target\` (use \`hint\` if set). When \`prBase\` is set, this workspace is the PR's code (its merge into the target branch, checked out by the engine): its change is exactly \`git diff <prBase> HEAD\`, and \`prFiles\` lists every changed file; read it that way, never from another source, and leave \`diffRange\` empty. Otherwise use git diff, or gh pr diff and gh pr view for a GitHub PR (a branch \`target\` is checked out by the engine: HEAD is its tip, and a branch only on a remote is \`origin/<target>\`; never fetch), and set \`diffRange\` to the git range the change is (e.g. "main...HEAD", "HEAD~1..HEAD"; "" for uncommitted changes). List every changed file to review in \`files\` (paths only), and every file the change deletes in \`deleted\` (the reviewers see the deletion in the diff). List in \`skipped\` every other changed file you leave out, with why ("path — lockfile", "— generated", "— binary"): leave out only lockfiles, generated and binary files. Summarize what changed per file in \`diffSummary\`, and in \`claims\` what the change says it does (the PR description or the commit messages, quoted briefly; "" if none). Set \`agents\` to how many reviewers should read in parallel (1 to ${MAX_AGENTS}): 1 for a few small files, more for a large diff. If there is no diff, leave \`files\` and \`deleted\` empty and say why in \`diffSummary\`.`,
      reads: ['target', 'hint', 'prBase', 'prFiles'],
      writes: ['diffSummary', 'claims', 'files', 'deleted', 'skipped', 'agents', 'diffRange'],
      retries: 2,
      checks: [
        {
          expr: `agents >= 1 && agents <= ${MAX_AGENTS}`,
          message: `Set agents to a whole number from 1 to ${MAX_AGENTS}.`,
        },
        {
          expr: 'len(unmatched(skipped, " — ")) == 0',
          message: 'Give each skipped file with why: "path — lockfile".',
        },
        {
          expr: 'empty(prBase) || subset(files + deleted, prPaths)',
          message:
            'List in files and deleted only paths the PR changes (prFiles), exactly as written there.',
        },
        {
          expr: 'empty(prBase) || len(files) + len(deleted) + len(skipped) == len(prPaths)',
          message:
            'Account for every file the PR changes (prFiles): each one in files, deleted, or skipped with why.',
        },
      ],
    },
    {
      id: 'hasDiff',
      kind: 'condition',
      label: 'Anything changed?',
      // A change that only deletes files is still a change: its callers are reviewed.
      expression: 'len(files) + len(deleted) > 0',
    },
    {
      id: 'capFiles',
      kind: 'compute',
      label: 'Files to review',
      // Each part is a call: a huge diff is reviewed up to maxFiles and the rest named.
      assign: [
        { field: 'overflow', expr: 'drop(files, maxFiles)' },
        { field: 'files', expr: 'take(files, maxFiles)' },
        { field: 'changedTests', expr: `pick(files, positions(files, "${TEST_PATH}"))` },
        { field: 'diffRange', expr: 'if(empty(prBase), diffRange, prBase + "..HEAD")' },
      ],
    },
    recallMemory('recall', 'diffSummary'),
    {
      id: 'scanDiff',
      kind: 'tool',
      label: 'Scan the diff',
      tool: 'diff.scan',
      inputs: { range: 'diffRange' },
      output: { diff: 'diff', smells: 'smellHints', masking: 'maskingFlags', error: 'diffError' },
    },
    {
      id: 'gatherContext',
      kind: 'agent',
      role: 'assessor',
      label: 'Gather context',
      directive: `Before anyone judges the change, gather what it must be judged against. You see the whole change (\`diff\`; read more with git diff \`diffRange\`, or git diff HEAD when it is empty) and can read the whole workspace (read-only). Write:
- \`claimList\`: what \`claims\` says the change does and what \`intent\` asks for, split into separate claims, one per entry: "C1 …", "C2 …" (empty only when both are empty).
- \`context\`: for each file of \`files\` (documentation and change/*.json release notes need none), 1 to 3 entries of what a reviewer should compare it with, each citing that code or rule (not the changed file) and naming the changed file it is for: "path:line — [CONVENTION|SIMILAR|CALLER] (for: changed path) why \`exact quote\`", e.g. "src/api.ts:40 — [SIMILAR] (for: src/client.ts) fetchUser already retries this way \`await retry(() => get(url))\`" or "AGENTS.md:3 — [CONVENTION] (for: db/schema.sql) a schema change needs a migration \`needs a new numbered migration\`". CONVENTION: a rule in AGENTS.md, the docs or a linter config; SIMILAR: existing code that does similar work (how the codebase already does it); CALLER: code that calls what changed. For each file of \`deleted\`, give the CALLER entries that still use what it deleted, "(for: the deleted path)" (none when nothing does).
- \`behaviours\`: each behaviour the change adds or changes: "B1 path:line — the behaviour \`exact quote\`", path:line at the changed line.
- \`obligations\`: each other change this codebase requires for this one to be complete, and only those: one a rule asks for (AGENTS.md, the docs, a linter), one every similar change includes (cite such a change), or one without which code breaks (a caller of a renamed or removed name). Not what would merely be nice: a new function nobody calls yet, docs or tooling the project does not have. Write each as "O1 [CALLER|MIGRATION|CONFIG|DOCS|ERRPATH] path:line — what must exist \`exact quote\`". e.g. "O1 [CALLER] src/greet.js:1 — greet.js must import the new name \`import { fullName }\`". path:line is the changed line (or a line that still uses deleted code) that creates the need; name what must exist in words, without a line number (it may not exist).
Every path:line must be a real line in this workspace with its quote: code the change deletes is not here, so cite the line that still uses it.${MEMORY_NOTE}`,
      reads: [
        'target',
        'hint',
        'intent',
        'claims',
        'diffSummary',
        'diffRange',
        'diff',
        'files',
        'deleted',
        'knownFacts',
      ],
      writes: ['claimList', 'context', 'behaviours', 'obligations'],
      cites: 'context',
      // Checked while the AI has the files open: a wrong one is fixed, not lost.
      citesAlso: ['behaviours', 'obligations'],
      retries: 2,
      checks: [
        orFailed({
          expr: '(empty(claims) && empty(intent)) || len(claimList) > 0',
          message: 'List what claims and intent say in claimList: "C1 …".',
        }),
        numberedList('claimList', 'C', '.', 'Number claimList in order: "C1 …", "C2 …".'),
        numberedList(
          'behaviours',
          'B',
          '.+:[0-9]+',
          'Number behaviours in order, each "B<n> path:line — behaviour `quote`".',
        ),
        numberedList(
          'obligations',
          'O',
          '[[](CALLER|MIGRATION|CONFIG|DOCS|ERRPATH)] .+:[0-9]+',
          'Number obligations in order, each "O<n> [CALLER|MIGRATION|CONFIG|DOCS|ERRPATH] path:line — what must exist `quote`".',
        ),
        orFailed({
          expr: 'len(unmatched(context, " — [[](CONVENTION|SIMILAR|CALLER)] [(]for: [^)]+[)] ")) == 0',
          message:
            'Write each context entry as "path:line — [CONVENTION|SIMILAR|CALLER] (for: changed path) why `quote`", citing the code or rule compared with.',
        }),
        orFailed({
          // Documentation needs no comparison; every code file does. An entry cites what the file is
          // compared with and says which file it is for (seen live: tying the citation to the
          // changed file made models cite it while quoting the rule).
          expr: `len(without(without(files, pick(files, positions(files, "${NO_CONTEXT_FILE}"))), heads(context, "${FOR_FILE}"))) == 0`,
          message:
            'Give each file of files (documentation and change/*.json release notes apart) at least one context entry tagged "(for: <that path>)", exactly as written in files.',
        }),
      ],
    },
    {
      id: 'contextOk',
      kind: 'condition',
      label: 'Context gathered?',
      expression: 'verdict.outcome != "failed"',
    },
    {
      id: 'noteContextFailed',
      kind: 'compute',
      label: 'Note it',
      assign: [
        {
          field: 'stepsFailed',
          expr: 'stepsFailed + ["Gather context (conventions, similar code, behaviours, required changes)"]',
        },
      ],
    },
    checkInventory('checkContext', 'context', 'rejectedContext'),
    checkInventory('checkBehaviours', 'behaviours', 'rejectedBehaviours'),
    checkInventory('checkObligations', 'obligations', 'rejectedObligations'),
    {
      id: 'mergeContext',
      kind: 'compute',
      label: 'Keep what failed',
      // A dropped entry is not lost: it keeps the review from ending "Looks good".
      assign: [
        {
          field: 'inventoryRejected',
          expr: 'rejectedContext + rejectedBehaviours + rejectedObligations',
        },
      ],
    },
    { id: 'hasFiles', kind: 'condition', label: 'Files to read?', expression: 'len(files) > 0' },
    {
      id: 'analyze',
      kind: 'agent',
      role: 'assessor',
      label: 'Find issues',
      reviewsCode: true,
      directive: `Review the changes to the files in \`files\` (yours only) for \`target\`: each file is given to you whole at the end of this prompt; read its diff hunks (git diff \`diffRange\`, or git diff HEAD when it is empty) against it, and the code it calls and is called by where an issue depends on it. \`context\` lists the conventions, similar code and callers to compare it with; \`behaviours\` and \`obligations\` what the change does and needs; \`smellHints\` and \`maskingFlags\` are leads from the engine's scan of the diff: check each, and report only real issues. Look for, ignoring formatting:
${categoryBullets()}
Write one issue per \`newFindings\` entry as "path:line — [CATEGORY] [HIGH|MEDIUM|LOW] problem \`exact quote of that line\`", only for issues you can point to. List in \`reviewed\` every file of \`files\` you read. An empty \`newFindings\` is right when the changes are sound. If you could not read the changes at all, say so with verdict outcome "failed" (\`reviewed\` may then be empty).
${ATTESTATION_DIRECTIVE}${MEMORY_NOTE}`,
      reads: [
        'target',
        'hint',
        'intent',
        'diffSummary',
        'diffRange',
        'claims',
        'files',
        'changedTests',
        'context',
        'behaviours',
        'obligations',
        'smellHints',
        'maskingFlags',
        'knownFacts',
      ],
      writes: ['newFindings', 'reviewed', 'attestations'],
      cites: 'newFindings',
      preload: 'files',
      // The engine says which files it could not give whole: they are not reported as read.
      preloadReport: { paths: 'partlyRead', reasons: 'partlyReadReasons' },
      fanOut: { over: 'files', per: 'filesPerAgent', agents: 'agents' },
      retries: 2,
      checks: [
        {
          // An honest "could not read it" is accepted: the files no part read are named as not
          // reviewed, and only a review that read nothing ends as not reviewed.
          expr: 'verdict.outcome == "failed" || subset(files, reviewed)',
          message: 'Read every file in files; list each in reviewed.',
        },
        ...findingChecks('newFindings'),
        ...attestationChecks('newFindings').map(orFailed),
      ],
    },
    {
      id: 'analyzed',
      kind: 'condition',
      label: 'Reviewed?',
      expression: 'verdict.outcome != "failed" || len(reviewed) > 0',
    },
    checkFindings('checkReview'),
    {
      id: 'mergeReview',
      kind: 'compute',
      label: 'Record issues',
      assign: mergeIssues('newFindings'),
    },
    {
      id: 'wholeChange',
      kind: 'agent',
      role: 'assessor',
      label: 'Judge the whole change',
      reviewsCode: true,
      // It settles the claims and the approach: a step up from the per-file reviewers.
      complexityShift: 1,
      // Again after each research round: what was found may settle a verdict.
      maxVisits: 4,
      visitsFrom: 'maxChaseRounds + maxDebateRounds + 1',
      directive: `You see the whole change at once (\`diff\`; read more with git diff \`diffRange\`, or git diff HEAD when it is empty, and the workspace, read-only). The per-file reviewers' checked findings are in \`findingsBrief\`: do not repeat them. \`evidence\` holds checked facts research found on what was unclear or objected to before: settle verdicts with them.${MEMORY_NOTE}
1. Claims: for each entry of \`claimList\`, in order, write a \`claimVerdicts\` entry "C<n> MET|PARTIAL|NOT MET|UNCLEAR — path:line — why".
2. Approach: is this the right place and the right approach? Compare it with the SIMILAR and CONVENTION entries of \`context\`; name one alternative and why it is worse; say which callers (CALLER entries) or behaviours could regress. A wrong approach or a likely regression is a finding (BUG or DESIGN).
3. Tests: for each entry of \`behaviours\`, in order, write a \`testVerdicts\` entry "B<n> TESTED|WEAK|UNTESTED|NA — the test path:line that checks it, or why". WEAK: a test runs it but would pass without the change. Judge the tests' quality with the T and FIRST rules.
4. Required changes: for each entry of \`obligations\`, in order, write an \`obligationVerdicts\` entry "O<n> FOUND|ABSENT — where it is, or what is missing".
5. Scope: put each path of \`files\` in \`related\` or \`unrelated\` (to what \`claims\` and \`intent\` say the change is for).
Every PARTIAL or NOT MET claim, WEAK or UNTESTED behaviour, ABSENT required change and unrelated file is also a finding in \`wholeFindings\` (CLAIM, TEST, MISSING or SCOPE), unless \`findingsBrief\` already has it. Code the change deletes is not in the workspace: cite the line that still uses it, and name what was deleted in words. Write each finding as "path:line — [CATEGORY] [HIGH|MEDIUM|LOW] problem \`exact quote of that line\`", CATEGORY one of ${CATEGORIES.split('|').join(', ')}. \`smellHints\` and \`maskingFlags\` are leads from the engine's scan: check each, and report only real issues.`,
      reads: [
        'target',
        'hint',
        'intent',
        'claims',
        'claimList',
        'diffSummary',
        'diffRange',
        'diff',
        'files',
        'deleted',
        'findingsBrief',
        'context',
        'behaviours',
        'obligations',
        'changedTests',
        'smellHints',
        'maskingFlags',
        'evidence',
        'knownFacts',
      ],
      writes: [
        'wholeFindings',
        'claimVerdicts',
        'testVerdicts',
        'obligationVerdicts',
        'related',
        'unrelated',
      ],
      cites: 'wholeFindings',
      retries: 2,
      checks: [
        ...findingChecks('wholeFindings').map(orFailed),
        verdictPerEntry('claimVerdicts', 'claimList', 'C', 'MET|PARTIAL|NOT MET|UNCLEAR'),
        verdictPerEntry('testVerdicts', 'behaviours', 'B', 'TESTED|WEAK|UNTESTED|NA'),
        verdictPerEntry('obligationVerdicts', 'obligations', 'O', 'FOUND|ABSENT'),
        orFailed({
          expr: 'len(without(files, related + unrelated)) == 0',
          message: 'Put every path of files in related or unrelated.',
        }),
        orFailed({
          expr: 'len(without(related + unrelated, files)) == 0 && len(related) + len(unrelated) == len(files)',
          message:
            'Put only paths of files in related and unrelated, each once, exactly as written there.',
        }),
        adverseIsFinding(
          'count(claimVerdicts, "^C[0-9]+ (PARTIAL|NOT MET) ")',
          'CLAIM',
          'PARTIAL or NOT MET claim',
        ),
        adverseIsFinding(
          'count(testVerdicts, "^B[0-9]+ (WEAK|UNTESTED) ")',
          'TEST',
          'WEAK or UNTESTED behaviour',
        ),
        adverseIsFinding(
          'count(obligationVerdicts, "^O[0-9]+ ABSENT ")',
          'MISSING',
          'ABSENT required change',
        ),
        adverseIsFinding('len(unrelated)', 'SCOPE', 'unrelated file'),
      ],
    },
    {
      id: 'wholeOk',
      kind: 'condition',
      label: 'Judged?',
      expression: 'verdict.outcome != "failed"',
    },
    {
      id: 'noteWholeFailed',
      kind: 'compute',
      label: 'Note it',
      assign: [
        {
          field: 'stepsFailed',
          expr: 'stepsFailed + ["Judge the whole change (claims, tests, required changes, scope)"]',
        },
      ],
    },
    checkFindings('checkWhole', 'wholeFindings'),
    {
      id: 'mergeWhole',
      kind: 'compute',
      label: 'Record its issues',
      assign: [
        // Seen live: the whole-change step repeats a per-file finding in other words. One at the
        // same place, of the same category, is the same finding.
        {
          field: 'wholeFindings',
          expr: `pick(wholeFindings, outside(heads(wholeFindings, "${PLACE}"), heads(unnumbered(findings), "${PLACE}")))`,
        },
        ...mergeIssues('wholeFindings'),
      ],
    },
    {
      id: 'aimChase',
      kind: 'compute',
      label: 'What to settle',
      // The claims the whole-change step could not settle, and the objections the debate sent back.
      assign: [
        {
          field: 'chaseItems',
          expr: 'pick(claimVerdicts, positions(claimVerdicts, "^C[0-9]+ UNCLEAR ")) + objectionGaps',
        },
      ],
    },
    {
      id: 'wantChase',
      kind: 'condition',
      label: 'Research them?',
      // Unclear claims get maxChaseRounds; objections the debate reopens bring their own round.
      expression: 'len(chaseItems) > 0 && (chaseRounds < maxChaseRounds || len(objectionGaps) > 0)',
    },
    REVIEW_CHASE.chase,
    REVIEW_CHASE.check,
    REVIEW_CHASE.merge,
    {
      id: 'useSecond',
      kind: 'condition',
      label: 'Second reviewer? (4)',
      expression: 'complexity >= 4 && !secondReviewed',
    },
    {
      id: 'second',
      kind: 'agent',
      role: 'assessor',
      label: 'Second reviewer',
      reviewsCode: true,
      // Another model family: its mistakes are less likely to be the first reviewers'.
      otherModel: true,
      complexityShift: 1,
      directive: `You are an INDEPENDENT second reviewer. Review the whole change to \`target\` yourself, from scratch: read the diff (git diff \`diffRange\`, or git diff HEAD when it is empty) and the code around it (read-only), without the first reviewers' findings. Compare it with \`context\`. Write each issue you find in \`newFindings\` as "path:line — [CATEGORY] [HIGH|MEDIUM|LOW] problem \`exact quote of that line\`", CATEGORY one of ${CATEGORIES.split('|').join(', ')}. An empty list is right when the change is sound.${MEMORY_NOTE}`,
      reads: [
        'target',
        'intent',
        'claims',
        'diffSummary',
        'diffRange',
        'diff',
        'files',
        'deleted',
        'context',
        'knownFacts',
      ],
      writes: ['newFindings'],
      cites: 'newFindings',
      retries: 2,
      checks: findingChecks('newFindings').map(orFailed),
    },
    checkFindings('checkSecond'),
    {
      id: 'mergeSecond',
      kind: 'compute',
      label: 'Record its issues',
      assign: [
        // One at the same place, of the same category, is already found.
        {
          field: 'newFindings',
          expr: `pick(newFindings, outside(heads(newFindings, "${PLACE}"), heads(unnumbered(findings), "${PLACE}")))`,
        },
        ...mergeIssues('newFindings'),
        { field: 'secondReviewed', expr: 'true' },
      ],
    },
    {
      id: 'wantSkeptic',
      kind: 'condition',
      label: 'Challenge? (≥2)',
      // complexity 0 is "auto": the run's default tier (2), so the skeptic plays. A review with
      // no finding is challenged too: a missed issue is the costliest mistake.
      expression: 'complexity != 1',
    },
    {
      id: 'skeptic',
      kind: 'agent',
      role: 'assessor',
      label: 'Skeptic',
      // Another model family than the reviewers': its blind spots are less likely the same.
      otherModel: true,
      maxVisits: 3,
      visitsFrom: 'maxDebateRounds + 1',
      directive: `You are the SKEPTIC of this review of \`target\`. Read the code each finding cites, and the code around it, in the workspace (read-only).
1. Write one \`proposedDispositions\` entry per finding, in the order of \`findings\`: "F<n> KEEP — why it holds", "F<n> DOWNGRADE MEDIUM — why it is less severe" (or DOWNGRADE LOW), "F<n> DROP — why it is wrong, with the code that shows it \`exact quote\`", or "F<n> DROP — duplicates F<m>" when an earlier finding already says the same problem. Also DROP a finding that asks for something nothing in the codebase requires (no rule, no similar change, no code that breaks without it), quoting the code or rule it misreads. When unsure, KEEP.
2. Attack the review's conclusions in \`objections\` (at most ${MAX_OBJECTIONS}, the ones most likely to change the review first): a verdict of \`claimVerdicts\`, \`testVerdicts\` or \`obligationVerdicts\` the code does not support (name it by its id: C2, B1, O3), or an issue every reviewer missed (name the file and line, "path:line"). Each must be concrete and checkable, and say what reading would settle it. An empty list is fine and better than invented concerns. \`pastObjections\` were raised and researched before (the facts found are in \`evidence\`): raise one again only with something new.${MEMORY_NOTE}`,
      reads: [
        'target',
        'claims',
        'intent',
        'findings',
        'claimVerdicts',
        'testVerdicts',
        'obligationVerdicts',
        'context',
        'evidence',
        'diffRange',
        'pastObjections',
        'knownFacts',
      ],
      writes: ['proposedDispositions', 'objections'],
      retries: 2,
      checks: [
        orFailed({
          expr: 'heads(proposedDispositions, "^F[0-9]+") == ids(findings)',
          message:
            'Write one proposedDispositions entry per finding, with its id, in the order of findings.',
        }),
        orFailed({
          expr: 'len(unmatched(proposedDispositions, "^F[0-9]+ (KEEP|DOWNGRADE MEDIUM|DOWNGRADE LOW|DROP) — ")) == 0',
          message:
            'Write each disposition as "F<n> KEEP|DOWNGRADE MEDIUM|DOWNGRADE LOW|DROP — why".',
        }),
        orFailed({
          expr: 'len(unmatched(pick(proposedDispositions, positions(proposedDispositions, "^F[0-9]+ DROP ")), "`[^`]+`|^F[0-9]+ DROP — duplicates F[0-9]+")) == 0',
          message:
            'Quote the code that refutes each finding you DROP, in backticks, or write "F<n> DROP — duplicates F<m>".',
        }),
        orFailed({
          expr: `len(objections) <= ${MAX_OBJECTIONS}`,
          message: `Give at most ${MAX_OBJECTIONS} objections: the ones most likely to change the review.`,
        }),
        orFailed({
          expr: `len(unmatched(objections, "${OBJECTION_TARGET}")) == 0`,
          message:
            'Name what each objection attacks: a verdict by its id (C2, B1, O3), or the missed issue by path:line.',
        }),
      ],
    },
    {
      id: 'skepticOk',
      kind: 'condition',
      label: 'Challenged?',
      expression: 'verdict.outcome != "failed"',
    },
    {
      id: 'noteSkepticFailed',
      kind: 'compute',
      label: 'Note it',
      assign: [
        {
          field: 'stepsFailed',
          expr: 'stepsFailed + ["Challenge findings (the findings stand unchallenged)"]',
        },
      ],
    },
    {
      id: 'usePragmatist',
      kind: 'condition',
      label: 'Pragmatist? (≥pragmatistFrom)',
      // Only when the skeptic would change something: a drop, a downgrade or an objection.
      expression:
        // complexity 0 is "auto": the run's default tier, 2.
        'if(complexity == 0, 2, complexity) >= pragmatistFrom && (len(objections) > 0 || count(proposedDispositions, "^F[0-9]+ (DROP|DOWNGRADE) ") > 0)',
    },
    {
      id: 'pragmatist',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Pragmatist',
      directive: `You are the PRAGMATIST: you neither defend the review nor side with the skeptic. 1. Copy \`proposedDispositions\` into \`dispositions\`, one per finding, in order, but turn each DROP or DOWNGRADE whose reason is THEORETICAL (unlikely, or it would not change what the author must do) into "F<n> KEEP — the challenge is theoretical: why". Keep a REAL one word for word. 2. For EVERY entry of \`objections\` write one \`objectionTriage\` entry, in order: "<objection, abbreviated>: REAL | THEORETICAL — reason". REAL means it could change the review and reading the code can settle it. Copy the REAL ones, word for word, into \`realObjections\`.`,
      reads: [
        'target',
        'findings',
        'proposedDispositions',
        'objections',
        'claimVerdicts',
        'testVerdicts',
        'obligationVerdicts',
        'evidence',
      ],
      writes: ['dispositions', 'objectionTriage', 'realObjections'],
      retries: 2,
      checks: [
        {
          expr: 'heads(dispositions, "^F[0-9]+") == ids(findings)',
          message:
            'Write one dispositions entry per finding, with its id, in the order of findings.',
        },
        {
          // It may only keep what the skeptic would change, never drop or downgrade on its own.
          expr: 'subset(pick(dispositions, positions(dispositions, "^F[0-9]+ (DROP|DOWNGRADE) ")), proposedDispositions)',
          message:
            'Copy each REAL DROP or DOWNGRADE from proposedDispositions word for word; you may only turn one into KEEP.',
        },
        {
          expr: 'len(objectionTriage) == len(objections)',
          message: 'Triage EVERY objection: one objectionTriage entry per objection.',
        },
        {
          expr: 'subset(realObjections, objections)',
          message: 'realObjections must be copied verbatim from objections.',
        },
      ],
    },
    {
      id: 'takeAll',
      kind: 'compute',
      label: 'Take the challenge',
      // Below pragmatistFrom, nobody triages: every drop stands and every objection is researched.
      assign: [
        { field: 'dispositions', expr: 'proposedDispositions' },
        { field: 'realObjections', expr: 'objections' },
      ],
    },
    {
      id: 'applyDispositions',
      kind: 'compute',
      label: 'Apply the challenge',
      // In order: the dropped are kept apart before findings is rewritten. An objection raised in
      // an earlier round again, word for word, was researched already: reported, not reopened.
      assign: [
        {
          field: 'dismissed',
          expr: 'dismissed + pick(findings, positions(dispositions, "^F[0-9]+ DROP "))',
        },
        {
          field: 'dismissals',
          expr: 'dismissals + pick(dispositions, positions(dispositions, "^F[0-9]+ DROP "))',
        },
        {
          field: 'findings',
          expr: `pick(findings, positions(dispositions, "^F[0-9]+ KEEP ")) + replace(pick(findings, positions(dispositions, "^F[0-9]+ DOWNGRADE MEDIUM ")), "${SEVERITY}", "[MEDIUM]") + replace(pick(findings, positions(dispositions, "^F[0-9]+ DOWNGRADE LOW ")), "${SEVERITY}", "[LOW]")`,
        },
        { field: 'findingsBrief', expr: 'brief(findings, 240)' },
        {
          field: 'unresolvedObjections',
          expr: 'unique(unresolvedObjections + without(realObjections, without(realObjections, pastObjections)))',
        },
        { field: 'realObjections', expr: 'without(realObjections, pastObjections)' },
      ],
    },
    {
      id: 'anyReal',
      kind: 'condition',
      label: 'Real objections?',
      expression: 'len(realObjections) > 0',
    },
    {
      id: 'roundsLeft',
      kind: 'condition',
      label: 'Research them? (rounds left, last one found something)',
      // Another round only while research still turns up findings: a barren round ends the debate.
      expression:
        'debateRounds < maxDebateRounds && (debateRounds == 0 || len(evidence) > debateFindings)',
    },
    {
      id: 'reopen',
      kind: 'compute',
      label: 'Research objections',
      assign: [
        { field: 'objectionGaps', expr: 'realObjections' },
        { field: 'pastObjections', expr: 'pastObjections + objections' },
        {
          field: 'debateLog',
          expr: 'append(debateLog, "Round " + text(debateRounds + 1) + ": " + text(len(realObjections)) + " of " + text(len(objections)) + " objections sent to research, " + text(len(findings)) + " findings standing")',
        },
        { field: 'debateRounds', expr: 'debateRounds + 1' },
        { field: 'debateFindings', expr: 'len(evidence)' },
      ],
    },
    {
      id: 'keepOpen',
      kind: 'compute',
      label: 'Report open objections',
      // Out of rounds, not out of objections: the real ones are said in the result, not dropped.
      assign: [
        { field: 'unresolvedObjections', expr: 'unique(unresolvedObjections + realObjections)' },
        {
          field: 'debateLog',
          expr: 'append(debateLog, "Stopped after " + text(debateRounds) + " round(s): " + if(debateRounds >= maxDebateRounds, "the cap (maxDebateRounds) was reached", "the last round\'s research found nothing new") + "; " + text(len(realObjections)) + " objection(s) reported as open")',
        },
      ],
    },
    {
      id: 'summarize',
      kind: 'compute',
      label: 'What is settled',
      assign: [
        {
          field: 'adverseVerdicts',
          expr: [
            'pick(claimVerdicts, positions(claimVerdicts, "^C[0-9]+ (PARTIAL|NOT MET) "))',
            ' + pick(testVerdicts, positions(testVerdicts, "^B[0-9]+ (WEAK|UNTESTED) "))',
            ' + pick(obligationVerdicts, positions(obligationVerdicts, "^O[0-9]+ ABSENT "))',
            ' + if(len(unrelated) > 0, ["Unrelated to what the change is for: " + join(unrelated, ", ")], [])',
          ].join(''),
        },
        {
          field: 'openItems',
          expr: [
            'if(count(claimVerdicts, "^C[0-9]+ UNCLEAR ") > 0, ["Claims the review could not settle: " + join(pick(claimVerdicts, positions(claimVerdicts, "^C[0-9]+ UNCLEAR ")), "; ")], [])',
            ' + if(len(inventoryRejected) > 0, ["Context the review was to use whose citation did not hold: " + join(inventoryRejected, "; ")], [])',
            ' + if(len(stepsFailed) > 0, ["Steps that failed, so what they check was not checked: " + join(stepsFailed, "; ")], [])',
            ' + if(len(dismissed) > 0 && len(findings) == 0, ["The skeptic dismissed every finding: check the dismissals"], [])',
            ' + if(len(unresolvedObjections) > 0, ["Objections the debate could not settle: " + join(unresolvedObjections, "; ")], [])',
          ].join(''),
        },
        {
          field: 'coverage',
          expr: [
            'join(',
            'if(len(skipped) > 0, ["Left out: " + join(skipped, "; ")], [])',
            ' + if(len(deleted) > 0, ["Deleted (nothing left to read; what still uses them was checked): " + join(deleted, ", ")], [])',
            ' + if(len(overflow) > 0, ["Not reviewed (over maxFiles " + text(maxFiles) + "): " + join(overflow, ", ")], [])',
            ' + if(len(partlyRead) > 0, ["Not read whole: " + join(partlyRead, ", ")], [])',
            ' + if(len(without(files, reviewed)) > 0, ["Not reviewed (the reviewer could not read them): " + join(without(files, reviewed), ", ")], [])',
            ' + if(len(unverified) > 0, ["Findings not verified (their quote is not in this checkout: is the reviewed code checked out?): " + join(unverified, "; ")], [])',
            ' + if(len(dismissed) > 0, ["Dismissed by the skeptic: " + join(dismissals, "; ")], [])',
            ' + if(!empty(diffError), ["The diff could not be scanned (no smell or masking leads): " + diffError], [])',
            ', "\n")',
          ].join(''),
        },
      ],
    },
    {
      id: 'hasIssues',
      kind: 'condition',
      label: 'Issues?',
      expression: 'len(findings) > 0',
    },
    {
      id: 'comment',
      kind: 'agent',
      role: 'assessor',
      label: 'Write review comments',
      // It explains the issue and shows the fix: held to the code standard like a reviewer.
      reviewsCode: true,
      // A few findings per part: each comment reads the code it explains.
      fanOut: { over: 'findings', per: 3, agents: 'agents' },
      directive: COMMENT_DIRECTIVE,
      reads: ['target', 'intent', 'claims', 'findings', 'context', 'evidence', 'diffRange'],
      writes: ['comments'],
      retries: 2,
      checks: [
        {
          expr: 'heads(comments, "^F[0-9]+") == ids(findings)',
          message: 'Write one comment per finding, starting with its id, in the order of findings.',
        },
        {
          expr: `len(unmatched(comments, "${COMMENT_SHAPE}")) == 0`,
          message:
            'Give each comment every part, in order: "What is wrong:", "Example:", "Why it matters:", "How to fix:".',
        },
      ],
    },
    {
      id: 'report',
      kind: 'agent',
      role: 'assessor',
      label: 'Write report',
      directive: `Write a short summary of the review of \`target\`: the findings by severity (HIGH first), one line each, citing its id; the full explanation of each is in \`comments\` (do not repeat it). ${CITE_BY_ID} Then list what is not settled (\`openItems\`, \`adverseVerdicts\`) and what \`coverage\` lists as not reviewed or not checked, and end with the files reviewed.`,
      reads: [
        'target',
        'claims',
        'findings',
        'diffSummary',
        'reviewed',
        'coverage',
        'openItems',
        'adverseVerdicts',
        'comments',
      ],
      writes: ['report'],
      retries: 2,
      checks: [citesFindings('report')],
    },
    {
      id: 'issuesSettled',
      kind: 'condition',
      label: 'All settled?',
      expression: 'len(openItems) == 0',
    },
    {
      id: 'anyUnverified',
      kind: 'condition',
      label: 'Findings unverified?',
      // Rejected citations are not "no issues": they were not checked against this code.
      expression: 'len(unverified) > 0',
    },
    {
      id: 'unverifiedReport',
      kind: 'compute',
      label: 'Not verified',
      assign: [
        {
          field: 'report',
          expr: '"Could not verify the review: " + text(len(unverified)) + " finding(s) quote code that is not in this checkout (check out the reviewed branch or PR here, then review again).\n" + coverage',
        },
      ],
    },
    {
      id: 'anyGaps',
      kind: 'condition',
      label: 'Reviewed in part?',
      expression: 'len(overflow) > 0 || len(partlyRead) > 0 || len(without(files, reviewed)) > 0',
    },
    {
      id: 'partReport',
      kind: 'compute',
      label: 'Reviewed in part',
      assign: [
        {
          field: 'report',
          expr: '"No issues found in what was reviewed, but not everything was: \n" + coverage + "\nReviewed: " + join(reviewed, ", ")',
        },
      ],
    },
    {
      id: 'anyOpen',
      kind: 'condition',
      label: 'Anything not settled?',
      // A backstop: an adverse verdict with no finding left is never "clean" (today a dropped or
      // rejected finding is caught earlier, by the dismissals or as not verified).
      expression: 'len(openItems) + len(adverseVerdicts) > 0',
    },
    {
      id: 'openReport',
      kind: 'compute',
      label: 'Not settled',
      assign: [
        {
          field: 'report',
          expr: '"No issue found, but some things are not settled:\n- " + join(openItems + adverseVerdicts, "\n- ") + if(empty(coverage), "", "\n" + coverage)',
        },
      ],
    },
    {
      id: 'cleanReport',
      kind: 'compute',
      label: 'Nothing found',
      assign: [
        {
          field: 'report',
          expr: '"No real issues found. Reviewed: " + join(reviewed, ", ") + if(empty(coverage), "", "\n" + coverage)',
        },
      ],
    },
    { id: 'issues', kind: 'end', label: 'Issues reported', outcome: 'success' },
    {
      id: 'issuesOpen',
      kind: 'end',
      label: 'Issues reported, not all settled',
      outcome: 'partial',
    },
    { id: 'clean', kind: 'end', label: 'Looks good', outcome: 'success' },
    { id: 'notVerified', kind: 'end', label: 'Could not verify', outcome: 'partial' },
    { id: 'partlyReviewed', kind: 'end', label: 'Reviewed in part', outcome: 'partial' },
    { id: 'openQuestions', kind: 'end', label: 'Not settled', outcome: 'partial' },
    {
      id: 'noDiffReport',
      kind: 'compute',
      label: 'Say why',
      assign: [{ field: 'report', expr: '"Could not review: " + diffSummary' }],
    },
    { id: 'noDiff', kind: 'end', label: 'No changes found', outcome: 'failed' },
    { id: 'notReviewed', kind: 'end', label: 'Could not review', outcome: 'failed' },
    ...READERS.nodes,
  ],
  edges: READERS.route([
    { id: 'start-prInfo', from: 'start', to: 'prInfo' },
    { id: 'prInfo-fetched', from: 'prInfo', to: 'prFetched' },
    { id: 'fetched-collect', from: 'prFetched', to: 'collect', branch: 'then' },
    { id: 'fetched-noPr', from: 'prFetched', to: 'noPr', branch: 'else' },
    { id: 'noPr-notReviewed', from: 'noPr', to: 'notReviewed' },
    { id: 'collect-hasDiff', from: 'collect', to: 'hasDiff' },
    { id: 'hasDiff-cap', from: 'hasDiff', to: 'capFiles', branch: 'then' },
    { id: 'hasDiff-noDiff', from: 'hasDiff', to: 'noDiffReport', branch: 'else' },
    { id: 'noDiffReport-end', from: 'noDiffReport', to: 'noDiff' },
    { id: 'cap-recall', from: 'capFiles', to: 'recall' },
    { id: 'recall-scan', from: 'recall', to: 'scanDiff' },
    { id: 'scan-context', from: 'scanDiff', to: 'gatherContext' },
    { id: 'context-ok', from: 'gatherContext', to: 'contextOk' },
    { id: 'contextOk-check', from: 'contextOk', to: 'checkContext', branch: 'then' },
    { id: 'contextOk-note', from: 'contextOk', to: 'noteContextFailed', branch: 'else' },
    { id: 'noteContext-hasFiles', from: 'noteContextFailed', to: 'hasFiles' },
    { id: 'checkContext-behaviours', from: 'checkContext', to: 'checkBehaviours' },
    { id: 'checkBehaviours-obligations', from: 'checkBehaviours', to: 'checkObligations' },
    { id: 'checkObligations-merge', from: 'checkObligations', to: 'mergeContext' },
    { id: 'mergeContext-hasFiles', from: 'mergeContext', to: 'hasFiles' },
    { id: 'hasFiles-analyze', from: 'hasFiles', to: 'analyze', branch: 'then' },
    // Only deletions: nothing to read file by file, but what still uses them is judged.
    { id: 'hasFiles-whole', from: 'hasFiles', to: 'wholeChange', branch: 'else' },
    { id: 'analyze-analyzed', from: 'analyze', to: 'analyzed' },
    { id: 'analyzed-check', from: 'analyzed', to: 'checkReview', branch: 'then' },
    { id: 'analyzed-not', from: 'analyzed', to: 'notReviewed', branch: 'else' },
    { id: 'check-merge', from: 'checkReview', to: 'mergeReview' },
    { id: 'merge-whole', from: 'mergeReview', to: 'wholeChange' },
    { id: 'whole-ok', from: 'wholeChange', to: 'wholeOk' },
    { id: 'wholeOk-check', from: 'wholeOk', to: 'checkWhole', branch: 'then' },
    { id: 'wholeOk-note', from: 'wholeOk', to: 'noteWholeFailed', branch: 'else' },
    { id: 'noteWhole-second', from: 'noteWholeFailed', to: 'useSecond' },
    { id: 'checkWhole-merge', from: 'checkWhole', to: 'mergeWhole' },
    { id: 'mergeWhole-aim', from: 'mergeWhole', to: 'aimChase' },
    { id: 'aim-wantChase', from: 'aimChase', to: 'wantChase' },
    { id: 'wantChase-chase', from: 'wantChase', to: 'chase', branch: 'then' },
    { id: 'wantChase-second', from: 'wantChase', to: 'useSecond', branch: 'else' },
    { id: 'chase-check', from: 'chase', to: 'checkChase' },
    { id: 'checkChase-merge', from: 'checkChase', to: 'mergeChase' },
    { id: 'mergeChase-whole', from: 'mergeChase', to: 'wholeChange', label: 're-judge' },
    { id: 'useSecond-second', from: 'useSecond', to: 'second', branch: 'then' },
    { id: 'useSecond-skeptic', from: 'useSecond', to: 'wantSkeptic', branch: 'else' },
    { id: 'second-check', from: 'second', to: 'checkSecond' },
    { id: 'checkSecond-merge', from: 'checkSecond', to: 'mergeSecond' },
    { id: 'mergeSecond-skeptic', from: 'mergeSecond', to: 'wantSkeptic' },
    { id: 'wantSkeptic-yes', from: 'wantSkeptic', to: 'skeptic', branch: 'then' },
    { id: 'wantSkeptic-no', from: 'wantSkeptic', to: 'summarize', branch: 'else' },
    { id: 'skeptic-ok', from: 'skeptic', to: 'skepticOk' },
    { id: 'skepticOk-pragmatist', from: 'skepticOk', to: 'usePragmatist', branch: 'then' },
    { id: 'skepticOk-note', from: 'skepticOk', to: 'noteSkepticFailed', branch: 'else' },
    { id: 'noteSkeptic-summarize', from: 'noteSkepticFailed', to: 'summarize' },
    { id: 'usePragmatist-yes', from: 'usePragmatist', to: 'pragmatist', branch: 'then' },
    { id: 'usePragmatist-no', from: 'usePragmatist', to: 'takeAll', branch: 'else' },
    { id: 'pragmatist-apply', from: 'pragmatist', to: 'applyDispositions' },
    { id: 'takeAll-apply', from: 'takeAll', to: 'applyDispositions' },
    { id: 'apply-anyReal', from: 'applyDispositions', to: 'anyReal' },
    { id: 'anyReal-rounds', from: 'anyReal', to: 'roundsLeft', branch: 'then' },
    { id: 'anyReal-summarize', from: 'anyReal', to: 'summarize', branch: 'else' },
    { id: 'rounds-reopen', from: 'roundsLeft', to: 'reopen', branch: 'then' },
    { id: 'rounds-keepOpen', from: 'roundsLeft', to: 'keepOpen', branch: 'else' },
    { id: 'reopen-aim', from: 'reopen', to: 'aimChase', label: 'research objections' },
    { id: 'keepOpen-summarize', from: 'keepOpen', to: 'summarize' },
    { id: 'summarize-hasIssues', from: 'summarize', to: 'hasIssues' },
    { id: 'hasIssues-comment', from: 'hasIssues', to: 'comment', branch: 'then' },
    { id: 'comment-report', from: 'comment', to: 'report' },
    { id: 'hasIssues-unverified', from: 'hasIssues', to: 'anyUnverified', branch: 'else' },
    { id: 'report-settled', from: 'report', to: 'issuesSettled' },
    { id: 'settled-issues', from: 'issuesSettled', to: 'issues', branch: 'then' },
    { id: 'settled-open', from: 'issuesSettled', to: 'issuesOpen', branch: 'else' },
    { id: 'unverified-report', from: 'anyUnverified', to: 'unverifiedReport', branch: 'then' },
    { id: 'unverified-gaps', from: 'anyUnverified', to: 'anyGaps', branch: 'else' },
    { id: 'unverifiedReport-end', from: 'unverifiedReport', to: 'notVerified' },
    { id: 'gaps-part', from: 'anyGaps', to: 'partReport', branch: 'then' },
    { id: 'gaps-open', from: 'anyGaps', to: 'anyOpen', branch: 'else' },
    { id: 'partReport-end', from: 'partReport', to: 'partlyReviewed' },
    { id: 'open-report', from: 'anyOpen', to: 'openReport', branch: 'then' },
    { id: 'open-clean', from: 'anyOpen', to: 'cleanReport', branch: 'else' },
    { id: 'openReport-end', from: 'openReport', to: 'openQuestions' },
    { id: 'cleanReport-clean', from: 'cleanReport', to: 'clean' },
  ]).concat(READERS.edges),
  demo: {
    goal: 'Review the current branch',
    context: { target: 'HEAD~1..HEAD' },
    tools: {
      scanDiff: () => ({
        diff: 'diff --git a/src/core/engine.ts b/src/core/engine.ts\n@@ -119,1 +119,2 @@\n+    attempts += 1;',
        smells: [],
        masking: [],
        error: '',
      }),
      checkContext: (s) => ({ valid: s.context, invalid: [] }),
      checkBehaviours: (s) => ({ valid: s.behaviours, invalid: [] }),
      checkObligations: (s) => ({ valid: s.obligations, invalid: [] }),
      checkReview: (s) => ({ valid: s.newFindings, invalid: [] }),
      checkWhole: (s) => ({ valid: s.wholeFindings, invalid: [] }),
      checkChase: (s) => ({ valid: s.chaseNotes, invalid: [] }),
      checkSecond: (s) => ({ valid: s.newFindings, invalid: [] }),
    },
    agents: {
      // Each finding keeps its location, so the reader can find the line.
      explain: (s) => ({
        updates: {
          summary: [
            '## In short',
            'The change has one serious problem. Fix it before you merge the change.',
            '',
            '## What we found',
            ...((s.findings as string[]) ?? []).map(
              (f) =>
                `- \`${/[^ `]+:[0-9]+(-[0-9]+)?/.exec(f)?.[0]}\` — The retry counter never goes back to zero.`,
            ),
            '',
            '## What to do',
            '1. Set the retry counter to zero after each step.',
            '',
            '## What is not certain',
            'Nothing.',
            '',
            '## How we checked',
            'We read each changed file. The pipeline of the change runs the tests.',
          ].join('\n'),
        },
        verdict: v('Reworded the review in plain English.'),
      }),
      collect: () => ({
        updates: {
          diffSummary: 'src/core/engine.ts: new retry logic',
          claims: 'Retry a failed step up to three times',
          files: ['src/core/engine.ts'],
          deleted: [],
          skipped: [],
          agents: 1,
          diffRange: 'HEAD~1..HEAD',
        },
        verdict: v('diff read'),
      }),
      // Data-driven, so a test can swap the files: a context entry per file, a verdict per entry.
      gatherContext: (s) => {
        const files = (s.files as string[]) ?? [];
        return {
          updates: {
            claimList: s.claims ? [`C1 ${String(s.claims)}`] : [],
            context: files.map(
              (f) =>
                `${f}:120 — [SIMILAR] (for: ${f}) the retry budget is counted per visit \`attempts += 1\``,
            ),
            behaviours: files
              .slice(0, 1)
              .map((f) => `B1 ${f}:120 — a failed step is tried again \`attempts += 1\``),
            obligations: [],
          },
          verdict: v('context gathered'),
        };
      },
      analyze: (s) => ({
        updates: {
          newFindings: [
            'src/core/engine.ts:120 — [BUG] [HIGH] retry counter never resets `attempts += 1`',
          ],
          reviewed: (s.files as string[]) ?? [],
          attestations: attest(['CORRECTNESS']),
        },
        verdict: v('1 issue'),
      }),
      wholeChange: (s) => {
        const behaviours = (s.behaviours as string[]) ?? [];
        return {
          updates: {
            wholeFindings: behaviours.map(
              (b) =>
                `${b.split(' ')[1]} — [TEST] [MEDIUM] no test checks the retry limit \`attempts += 1\``,
            ),
            claimVerdicts: ((s.claimList as string[]) ?? []).map(
              (c) =>
                `${idOf(c)} MET — src/core/engine.ts:120 — it retries; F1 is about the counter`,
            ),
            testVerdicts: behaviours.map(
              (b) => `${idOf(b)} UNTESTED — no test runs the retry path`,
            ),
            obligationVerdicts: ((s.obligations as string[]) ?? []).map(
              (o) => `${idOf(o)} FOUND — it is in the change`,
            ),
            related: (s.files as string[]) ?? [],
            unrelated: [],
          },
          verdict: v('judged'),
        };
      },
      skeptic: (s) => ({
        updates: {
          proposedDispositions: ((s.findings as string[]) ?? []).map(
            (f) => `${f.split(' ')[0]} KEEP — the cited line does what the finding says`,
          ),
          objections: [],
        },
        verdict: v('challenged'),
      }),
      // Research on what was unclear or objected to: a fact per point, where it was found.
      chase: (s) => ({
        updates: {
          queries: ['git diff HEAD~1..HEAD -- src/core/engine.ts'],
          chaseNotes: ((s.chaseItems as string[]) ?? []).map(
            () => 'src/core/engine.ts:120 — the counter is bumped once per visit `attempts += 1`',
          ),
        },
        verdict: v('researched'),
      }),
      second: () => ({ updates: { newFindings: [] }, verdict: v('found nothing new') }),
      // Keeps what the skeptic would change and sends every objection to research.
      pragmatist: (s) => ({
        updates: {
          dispositions: (s.proposedDispositions as string[]) ?? [],
          objectionTriage: ((s.objections as string[]) ?? []).map(
            (o) => `${o.slice(0, 40)}: REAL — reading the code settles it`,
          ),
          realObjections: (s.objections as string[]) ?? [],
        },
        verdict: v('triaged'),
      }),
      // One full comment per finding: what is wrong, an example, why it matters, how to fix.
      comment: (s) => ({
        updates: {
          comments: ((s.findings as string[]) ?? []).map((f) =>
            [
              `${f.split(' ')[0]} The retry counter is never set back to zero`,
              'What is wrong: `attempts` grows on every visit to the step (src/core/engine.ts:120) and is never reset when a step succeeds.',
              'Example: a step fails twice, succeeds, then fails once more: today the third failure is "attempt 4 of 3" and the run stops; expected: "attempt 1 of 3", and it retries.',
              'Why it matters: a run that recovered once can never recover again, so long runs stop on the first later failure.',
              'How to fix: set `attempts = 0` when a step succeeds, and add a test that fails, succeeds, then fails again and expects a retry.',
            ].join('\n'),
          ),
        },
        verdict: v('commented'),
      }),
      report: (s) => ({
        updates: {
          report: ((s.findings as string[]) ?? [])
            .map((f) => `${f.split(' — ')[1]?.split('`')[0]?.trim()} [${f.split(' ')[0]}]`)
            .join('\n'),
        },
        verdict: v('reported'),
      }),
    },
  },
};
