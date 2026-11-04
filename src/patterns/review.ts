import { MAX_AGENTS, type Pattern } from '../core/types.js';
import { TEST_PATH } from './phases/stability.js';
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

/** A finding: "path:line — [CATEGORY] [SEVERITY] problem `exact quote`". */
const CATEGORIES = 'BUG|SECURITY|PERF|TEST|FLAKY|REDUNDANT|DESIGN|CLAIM';
const FINDING_FORMAT = `^.+:[0-9]+(-[0-9]+)? — [[](${CATEGORIES})] [[](HIGH|MEDIUM|LOW)] `;

/**
 * Review of a branch or PR. The changed files are listed (what was left out, and why, is
 * recorded), the engine runs the tests and lint on the code as it is, then the files are
 * reviewed in parallel parts for bugs, security, performance, tests (missing, weakened, flaky),
 * redundancy, design and whether the change does what it claims. Every finding cites the code
 * and is checked before it counts. It ends "Looks good" only when everything was read, every
 * finding verified and the checks passed: a review that could not verify its findings (e.g. the
 * PR's branch is not checked out), or read only part of the change, says so and ends partial.
 */
export const review: Pattern = {
  name: 'review',
  description:
    'Review a branch or PR: bugs, security, performance, tests, flaky tests, redundancy, design and what it claims; the engine runs the tests; every issue is cited and checked.',
  verbTriggers: ['review', 'audit', 'check my changes'],
  requiredContext: ['target'],
  goalFrom: 'target',
  result: ['report', 'findings', 'unverified', 'coverage', 'testsPassed'],
  maxSteps: 200,
  state: [
    {
      name: 'target',
      type: 'string',
      description:
        'Branch, commit range or PR to review (its code must be checked out here: citations are checked against this workspace)',
    },
    { name: 'hint', type: 'string', description: 'Optional: what to focus on' },
    { name: 'diffSummary', type: 'string', description: 'What changed, per file' },
    {
      name: 'claims',
      type: 'string',
      description: 'What the change says it does (PR description, commit messages)',
    },
    { name: 'files', type: 'string[]', description: 'Changed files to review (paths)' },
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
      name: 'verify',
      type: 'boolean',
      initial: true,
      description: 'The engine runs the tests (and lintCommand) on the code as it is',
    },
    {
      name: 'testCommand',
      type: 'string',
      description: "Command that runs the tests (empty: the project's test script)",
    },
    {
      name: 'lintCommand',
      type: 'string',
      description: 'Optional lint or typecheck command that must also pass',
    },
    { name: 'testTimeoutMs', type: 'number', initial: 600_000, min: 1000 },
    { name: 'testsPassed', type: 'boolean', initial: true },
    { name: 'testOutput', type: 'string', description: 'Test output, run by the engine' },
    { name: 'lintPassed', type: 'boolean', initial: true },
    { name: 'lintOutput', type: 'string' },
    { name: 'reviewed', type: 'string[]', description: 'Files whose changes were read' },
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
    { name: 'findings', type: 'string[]', description: 'Checked issues, numbered F1, F2…' },
    ...EVIDENCE_STATE,
    {
      name: 'coverage',
      type: 'string',
      description: 'What was not reviewed or not checked, and why',
    },
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
      // A PR can change on GitHub, which the workspace fingerprint does not see: never replayed.
      fresh: true,
      directive: `Read the diff for \`target\` (e.g. git diff, or gh pr diff and gh pr view for a PR; use \`hint\` if set). List every changed file to review in \`files\` (paths only). List in \`skipped\` every changed file you leave out, with why ("path — lockfile", "— generated", "— binary"): leave out only lockfiles, generated, binary and deleted files ("path — deleted": the reviewers see the deletion in the diff). Summarize what changed per file in \`diffSummary\`, and in \`claims\` what the change says it does (the PR description or the commit messages, quoted briefly; "" if none). Set \`agents\` to how many reviewers should read in parallel (1 to ${MAX_AGENTS}): 1 for a few small files, more for a large diff. If there is no diff, leave \`files\` empty and say why in \`diffSummary\`.`,
      reads: ['target', 'hint'],
      writes: ['diffSummary', 'claims', 'files', 'skipped', 'agents'],
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
      ],
    },
    {
      id: 'hasDiff',
      kind: 'condition',
      label: 'Anything changed?',
      expression: 'len(files) > 0',
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
      ],
    },
    { id: 'verifyOn', kind: 'condition', label: 'Run the checks?', expression: 'verify' },
    {
      id: 'runTests',
      kind: 'tool',
      label: 'Run tests',
      tool: 'tests.run',
      // Fresh every time (a cached timeout or flaky failure is no verdict); no test command
      // is "not run".
      args: { optional: true },
      inputs: { command: 'testCommand', timeoutMs: 'testTimeoutMs' },
      output: { passed: 'testsPassed', output: 'testOutput' },
    },
    { id: 'hasLint', kind: 'condition', label: 'Lint?', expression: '!empty(lintCommand)' },
    {
      id: 'runLint',
      kind: 'tool',
      label: 'Run lint',
      tool: 'tests.run',
      inputs: { command: 'lintCommand', timeoutMs: 'testTimeoutMs' },
      output: { passed: 'lintPassed', output: 'lintOutput' },
    },
    {
      id: 'analyze',
      kind: 'agent',
      role: 'assessor',
      label: 'Find issues',
      directive: `Review the changes to the files in \`files\` (yours only) for \`target\`: each file is given to you whole at the end of this prompt; read its diff hunks (git diff) against it, and the code it calls and is called by where an issue depends on it. Look for, ignoring style:
- BUG: wrong behaviour, missed cases, broken error handling, a logic error;
- SECURITY: injection, secrets, unsafe input, missing checks;
- PERF: needless work on a hot path, repeated I/O or queries in a loop, unbounded growth;
- TEST: changed behaviour no test covers (\`changedTests\` lists the changed tests), tests removed, skipped or loosened, assertions that would pass without the change;
- FLAKY: tests that depend on timing, the real clock, order, shared state, randomness, the network or parallel workers;
- REDUNDANT: code that duplicates an existing helper or another part of the change;
- DESIGN: a change against the codebase's structure or rules (layering, module boundaries, conventions in AGENTS.md or the docs);
- CLAIM: the change does not do what \`claims\` says.
\`testOutput\` and \`lintOutput\` are the engine's runs on this code: a failure there that your files cause is a finding at its cause. Write one issue per \`newFindings\` entry as "path:line — [CATEGORY] [HIGH|MEDIUM|LOW] problem \`exact quote of that line\`", only for issues you can point to. List in \`reviewed\` every file of \`files\` you read. An empty \`newFindings\` is right when the changes are sound. If you could not read the changes at all, say so with verdict outcome "failed" (\`reviewed\` may then be empty).`,
      reads: [
        'target',
        'hint',
        'diffSummary',
        'claims',
        'files',
        'changedTests',
        'testOutput',
        'lintOutput',
      ],
      writes: ['newFindings', 'reviewed'],
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
        {
          expr: `len(unmatched(newFindings, "${FINDING_FORMAT}")) == 0`,
          message: `Write each finding as "path:line — [CATEGORY] [HIGH|MEDIUM|LOW] problem \`quote\`", CATEGORY one of ${CATEGORIES.split('|').join(', ')}.`,
        },
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
      assign: [
        ...MERGE_FINDINGS,
        {
          field: 'coverage',
          expr: [
            'join(',
            'if(len(skipped) > 0, ["Left out: " + join(skipped, "; ")], [])',
            ' + if(len(overflow) > 0, ["Not reviewed (over maxFiles " + text(maxFiles) + "): " + join(overflow, ", ")], [])',
            ' + if(len(partlyRead) > 0, ["Not read whole: " + join(partlyRead, ", ")], [])',
            ' + if(len(without(files, reviewed)) > 0, ["Not reviewed (the reviewer could not read them): " + join(without(files, reviewed), ", ")], [])',
            ' + if(len(unverified) > 0, ["Findings not verified (their quote is not in this checkout: is the reviewed code checked out?): " + join(unverified, "; ")], [])',
            ' + if(!verify, ["Tests not run (verify is off)"], if(includes(testOutput, "not run: "), ["Tests " + testOutput], []))',
            ' + if(includes(lintOutput, "not run: "), ["Lint " + lintOutput], [])',
            ', "\n")',
          ].join(''),
        },
      ],
    },
    {
      id: 'hasIssues',
      kind: 'condition',
      label: 'Issues?',
      expression: 'len(findings) > 0 || !testsPassed || !lintPassed',
    },
    {
      id: 'report',
      kind: 'agent',
      role: 'assessor',
      label: 'Write report',
      directive: `Write a short review of \`target\` from \`findings\`, ordered by severity (HIGH first), with a suggested fix for each. ${CITE_BY_ID} If \`testsPassed\` or \`lintPassed\` is false, the engine's run failed: say so first, with the failing tests or errors from \`testOutput\` or \`lintOutput\`. Then say what \`coverage\` lists as not reviewed or not checked, and end with the files reviewed.`,
      reads: [
        'target',
        'claims',
        'findings',
        'diffSummary',
        'reviewed',
        'coverage',
        'testsPassed',
        'testOutput',
        'lintPassed',
        'lintOutput',
      ],
      writes: ['report'],
      retries: 2,
      checks: [
        {
          // With no findings (only failing checks) there is nothing to cite.
          expr: 'len(findings) == 0 || (len(refs(report)) > 0 && subset(refs(report), ids(findings)))',
          message: citesFindings('report').message,
        },
      ],
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
    { id: 'clean', kind: 'end', label: 'Looks good', outcome: 'success' },
    { id: 'notVerified', kind: 'end', label: 'Could not verify', outcome: 'partial' },
    { id: 'partlyReviewed', kind: 'end', label: 'Reviewed in part', outcome: 'partial' },
    { id: 'noDiff', kind: 'end', label: 'No changes found', outcome: 'failed' },
    { id: 'notReviewed', kind: 'end', label: 'Could not review', outcome: 'failed' },
  ],
  edges: [
    { id: 'start-collect', from: 'start', to: 'collect' },
    { id: 'collect-hasDiff', from: 'collect', to: 'hasDiff' },
    { id: 'hasDiff-cap', from: 'hasDiff', to: 'capFiles', branch: 'then' },
    { id: 'hasDiff-noDiff', from: 'hasDiff', to: 'noDiff', branch: 'else' },
    { id: 'cap-verifyOn', from: 'capFiles', to: 'verifyOn' },
    { id: 'verifyOn-tests', from: 'verifyOn', to: 'runTests', branch: 'then' },
    { id: 'verifyOn-analyze', from: 'verifyOn', to: 'analyze', branch: 'else' },
    { id: 'tests-hasLint', from: 'runTests', to: 'hasLint' },
    { id: 'hasLint-lint', from: 'hasLint', to: 'runLint', branch: 'then' },
    { id: 'hasLint-analyze', from: 'hasLint', to: 'analyze', branch: 'else' },
    { id: 'lint-analyze', from: 'runLint', to: 'analyze' },
    { id: 'analyze-analyzed', from: 'analyze', to: 'analyzed' },
    { id: 'analyzed-check', from: 'analyzed', to: 'checkReview', branch: 'then' },
    { id: 'analyzed-not', from: 'analyzed', to: 'notReviewed', branch: 'else' },
    { id: 'check-merge', from: 'checkReview', to: 'mergeReview' },
    { id: 'merge-hasIssues', from: 'mergeReview', to: 'hasIssues' },
    { id: 'hasIssues-report', from: 'hasIssues', to: 'report', branch: 'then' },
    { id: 'hasIssues-unverified', from: 'hasIssues', to: 'anyUnverified', branch: 'else' },
    { id: 'report-issues', from: 'report', to: 'issues' },
    { id: 'unverified-report', from: 'anyUnverified', to: 'unverifiedReport', branch: 'then' },
    { id: 'unverified-gaps', from: 'anyUnverified', to: 'anyGaps', branch: 'else' },
    { id: 'unverifiedReport-end', from: 'unverifiedReport', to: 'notVerified' },
    { id: 'gaps-part', from: 'anyGaps', to: 'partReport', branch: 'then' },
    { id: 'gaps-clean', from: 'anyGaps', to: 'cleanReport', branch: 'else' },
    { id: 'partReport-end', from: 'partReport', to: 'partlyReviewed' },
    { id: 'cleanReport-clean', from: 'cleanReport', to: 'clean' },
  ],
  demo: {
    goal: 'Review the current branch',
    context: { target: 'HEAD~1..HEAD' },
    tools: {
      runTests: () => ({ passed: true, output: 'Tests 12 passed', command: 'npm test' }),
      checkReview: (s) => ({ valid: s.newFindings, invalid: [] }),
    },
    agents: {
      collect: () => ({
        updates: {
          diffSummary: 'src/core/engine.ts: new retry logic',
          claims: 'Retry a failed step up to three times',
          files: ['src/core/engine.ts'],
          skipped: [],
          agents: 1,
        },
        verdict: v('diff read'),
      }),
      analyze: (s) => ({
        updates: {
          newFindings: [
            'src/core/engine.ts:120 — [BUG] [HIGH] retry counter never resets `attempts += 1`',
          ],
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
