/**
 * PR review: after the tests pass, a reviewer reads the change the way a pull
 * request is reviewed. Blocking comments go back to the edit step (the engine
 * re-runs the tests), and the review runs again, until it approves. After
 * maxReviewRounds a person decides: accept the change as it is, or stop.
 */
import type { ScoreEdge, ScoreNode, StateField } from '../../core/types.js';
import type { Fragment } from './debate.js';

export interface PrReviewConfig {
  /** What the change is for (issue, request, target). */
  readonly subject: string;
  /** What the reviewer checks the change against (root cause, design, plan…). */
  readonly against: readonly string[];
  /** The edit step that addresses review comments (editVerify's 'apply'). */
  readonly edit: string;
  /** Where to go once approved, or accepted by a person. */
  readonly approved: string;
  /** Where to go when the person stops it. */
  readonly stopped: string;
  /** Added to the review directive, with the fields it reads (fix: the stability gate). */
  readonly reviewNote?: string;
  readonly reviewReads?: readonly string[];
}

export const PR_REVIEW_STATE: readonly StateField[] = [
  { name: 'reviewDecision', type: 'string', description: 'APPROVE | REQUEST_CHANGES' },
  {
    name: 'reviewComments',
    type: 'string[]',
    description:
      'One per issue: "BLOCKING | NIT path:line — what to change and why", or "RESOLVED path:line — …" for an earlier one now addressed',
  },
  { name: 'reviewSummary', type: 'string', description: 'The review in a few sentences' },
  { name: 'reviewRounds', type: 'number', description: 'Reviews sent back to editing' },
  { name: 'maxReviewRounds', type: 'number', initial: 2 },
  {
    name: 'reviewedHash',
    type: 'string',
    description: 'The patch the review last sent back: it passed the checks',
  },
  { name: 'reviewedTestOutput', type: 'string', description: "The reviewed patch's test run" },
  { name: 'reviewedLintOutput', type: 'string', description: "The reviewed patch's lint run" },
];

export function prReviewPhase(cfg: PrReviewConfig): Fragment {
  const nodes: ScoreNode[] = [
    {
      id: 'prReview',
      kind: 'agent',
      role: 'assessor',
      label: 'PR review',
      reviewsCode: true,
      // Another model family than the author's: its blind spots are less likely to be the same.
      otherModel: true,
      maxVisits: 8,
      visitsFrom: '(maxReviewRounds + 1) * 3',
      directive: `Review this change as you would a pull request, against \`${cfg.subject}\` and ${cfg.against.map((a) => `\`${a}\``).join(', ')}. Read \`diff\` and the code around it in the workspace (read-only). Look for: wrong behaviour or missed cases, a fix of the symptom instead of the cause, missing or weak tests (a test that would pass without the change), tests removed, skipped or loosened, a change to \`checkFiles\` (how the tests or lint run) that weakens or narrows the checks, broken conventions of the codebase, needless complexity, code the change adds or edits that breaks the Clean Code standard below (name the rule), and leftover debug code. Write each issue in \`reviewComments\` as "BLOCKING path:line — what to change and why" or "NIT path:line — …". Only real problems are BLOCKING: a clear break of a Clean Code rule in the new code is one (a function doing several things, a misleading name, a swallowed error, copied logic); judgment calls and style preferences are NITs. Earlier rounds' comments, if any, are in \`reviewComments\`: check whether each was addressed, and list each one that was as "RESOLVED path:line — how" (keep it BLOCKING if it was not). Set \`reviewDecision\` to REQUEST_CHANGES if any comment is BLOCKING, otherwise APPROVE (the engine checks that they agree), and summarize in \`reviewSummary\`.${cfg.reviewNote ?? ''}`,
      reads: [
        cfg.subject,
        ...cfg.against,
        'diff',
        'changes',
        'checkFiles',
        'testOutput',
        'reviewComments',
        ...(cfg.reviewReads ?? []),
      ],
      writes: ['reviewDecision', 'reviewComments', 'reviewSummary'],
      retries: 2,
      checks: [
        {
          expr: 'includes(["APPROVE", "REQUEST_CHANGES"], reviewDecision)',
          message: 'reviewDecision must be APPROVE or REQUEST_CHANGES.',
        },
        {
          expr: 'len(unmatched(reviewComments, "^(BLOCKING|NIT|RESOLVED) ")) == 0',
          message:
            'Start each reviewComments entry with BLOCKING, NIT or RESOLVED (an earlier comment now addressed).',
        },
        // The decision follows the comments, both ways: an APPROVE that still blocks would be
        // accepted unseen, and a REQUEST_CHANGES with nothing blocking sends the edit back for nothing.
        {
          expr: 'reviewDecision != "APPROVE" || count(reviewComments, "^BLOCKING ") == 0',
          message:
            'APPROVE with a BLOCKING comment: request changes, or mark the comment NIT or RESOLVED if it does not block.',
        },
        {
          expr: 'reviewDecision == "APPROVE" || count(reviewComments, "^BLOCKING ") > 0',
          message: 'Requesting changes needs at least one BLOCKING comment saying what to change.',
        },
        { expr: 'len(reviewSummary) > 0', message: 'Summarize the review in reviewSummary.' },
      ],
    },
    {
      id: 'reviewApproved',
      kind: 'condition',
      label: 'Approved?',
      expression: 'reviewDecision == "APPROVE"',
    },
    {
      id: 'reviewRoundsLeft',
      kind: 'condition',
      label: 'Review again?',
      // Out of review rounds, or out of the run's edit budget: a person decides.
      expression: 'reviewRounds < maxReviewRounds && edits < maxEdits',
    },
    {
      id: 'addressReview',
      kind: 'compute',
      label: 'Back to editing',
      assign: [
        { field: 'reviewRounds', expr: 'reviewRounds + 1' },
        // What the reviewer saw, verified: the only patch a person may accept if no edit helps.
        { field: 'reviewedHash', expr: 'diffHash' },
        { field: 'reviewedTestOutput', expr: 'testOutput' },
        { field: 'reviewedLintOutput', expr: 'lintOutput' },
        { field: 'failureKind', expr: '"REVIEW"' },
        {
          field: 'failureReason',
          expr: '"the PR review requested changes: address every BLOCKING entry of reviewComments"',
        },
        // Each review round gets the full budget of test attempts.
        { field: 'attempts', expr: '0' },
      ],
    },
    {
      id: 'acceptAnyway',
      kind: 'approval',
      // Nobody to ask: a change the review blocked is not accepted.
      unattended: 'reject',
      label: 'Accept despite review?',
      message:
        'The reviewer still requests changes, and no review round is left (or no edit changed the reviewed patch). The change shown is the one that passed the tests and was reviewed. Approve to accept it as it is (the comments stay in the result), or reject to stop.',
      writes: [],
      shows: ['reviewDecision', 'reviewComments', 'reviewSummary', 'checkFiles', 'diff'],
    },
  ];
  const edges: ScoreEdge[] = [
    { id: 'prReview-approved', from: 'prReview', to: 'reviewApproved' },
    { id: 'reviewApproved-done', from: 'reviewApproved', to: cfg.approved, branch: 'then' },
    { id: 'reviewApproved-left', from: 'reviewApproved', to: 'reviewRoundsLeft', branch: 'else' },
    {
      id: 'reviewRoundsLeft-address',
      from: 'reviewRoundsLeft',
      to: 'addressReview',
      branch: 'then',
    },
    {
      id: 'reviewRoundsLeft-ask',
      from: 'reviewRoundsLeft',
      to: 'acceptAnyway',
      branch: 'else',
      label: 'still not approved',
    },
    { id: 'addressReview-edit', from: 'addressReview', to: cfg.edit, label: 'address review' },
    { id: 'acceptAnyway-done', from: 'acceptAnyway', to: cfg.approved, branch: 'approved' },
    { id: 'acceptAnyway-stop', from: 'acceptAnyway', to: cfg.stopped, branch: 'rejected' },
  ];
  return {
    state: PR_REVIEW_STATE,
    nodes,
    edges,
    entry: 'prReview',
    group: {
      id: 'prReviewPhase',
      label: 'PR review',
      description: 'Review the change; blocking comments go back to editing until approved',
      nodes: nodes.map((n) => n.id),
    },
  };
}
