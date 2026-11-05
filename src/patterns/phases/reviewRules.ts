/**
 * What a code review looks for and how it writes it down, shared by `review` and the PR review
 * phase: the categories, the finding format, the Clean Code rule ids, and the per-dimension
 * attestations that prove each dimension was looked at.
 */
import { CLEAN_CODE_IDS, CLEAN_ID_PATTERN } from '../../core/standards.js';
import type { AcceptanceCheck } from '../../core/types.js';

/** Each category and what it covers, in the order a reviewer is asked about them. */
export const REVIEW_CATEGORIES: readonly (readonly [name: string, covers: string])[] = [
  ['BUG', 'wrong behaviour, missed cases, a logic error, wrong at a boundary'],
  ['SECURITY', 'injection, secrets, unsafe input, missing checks'],
  ['PERF', 'needless work on a hot path, repeated I/O or queries in a loop, unbounded growth'],
  [
    'CONCURRENCY',
    'shared mutable state, async work not awaited, races between callbacks or workers, check-then-act, locks taken in different orders',
  ],
  [
    'ERRPATH',
    'null, undefined, empty or error results not handled on new branches; an error swallowed, or a failure reported as success',
  ],
  [
    'COMPAT',
    'a changed exported signature, config key, schema, file or wire format, CLI flag or default that callers, stored data or other services rely on',
  ],
  [
    'TEST',
    'changed behaviour no test covers, tests removed, skipped or loosened, assertions that would pass without the change',
  ],
  [
    'FLAKY',
    'tests that depend on timing, the real clock, order, shared state, randomness, the network or parallel workers',
  ],
  [
    'MISSING',
    'a change the diff needs but does not contain (a caller not updated, a migration, config, docs, an error path): cite the changed line that creates the need, and name what is missing in words, without a line number (it does not exist)',
  ],
  ['REDUNDANT', 'code that duplicates an existing helper or another part of the change'],
  [
    'DESIGN',
    "against the codebase's structure or rules (layering, module boundaries, AGENTS.md, the docs): name the sibling code you compared it with (path:line) and the convention it breaks",
  ],
  [
    'CLEAN',
    'code the change adds or edits that breaks a Clean Code rule: put the rule id after the severity, e.g. "[CLEAN] [MEDIUM] [G5]"',
  ],
  ['CLAIM', 'the change does not do what `claims` (or `intent`) says'],
  ['SCOPE', 'an edit unrelated to what `claims` (or `intent`) says the change is for'],
];

export const CATEGORIES = REVIEW_CATEGORIES.map(([c]) => c).join('|');

/** A finding: "path:line — [CATEGORY] [SEVERITY] problem `exact quote`". */
export const FINDING_FORMAT = `^.+:[0-9]+(-[0-9]+)? — [[](${CATEGORIES})] [[](HIGH|MEDIUM|LOW)] `;

/** The categories as directive bullets. */
export const categoryBullets = (): string =>
  REVIEW_CATEGORIES.map(([c, covers]) => `- ${c}: ${covers};`).join('\n');

const CLEAN_IDS = `[${CLEAN_CODE_IDS.map(([id]) => JSON.stringify(`[${id}]`)).join(', ')}]`;

/** The format of each finding, and a catalogue rule id on each CLEAN one. */
export function findingChecks(field: string): AcceptanceCheck[] {
  return [
    {
      expr: `len(unmatched(${field}, "${FINDING_FORMAT}")) == 0`,
      message: `Write each finding as "path:line — [CATEGORY] [HIGH|MEDIUM|LOW] problem \`quote\`", CATEGORY one of ${CATEGORIES.split('|').join(', ')}.`,
    },
    {
      expr: `subset(heads(pick(${field}, positions(${field}, " — [[]CLEAN] ")), "${CLEAN_ID_PATTERN}"), ${CLEAN_IDS})`,
      message:
        'Give each CLEAN finding a rule id from the Clean Code list, after the severity: "[CLEAN] [MEDIUM] [G5] …".',
    },
  ];
}

/**
 * One line per review dimension, so "I did not look at concurrency" and "concurrency is fine"
 * read differently: "D5 PITFALLS: NONE — what you examined, path:line".
 */
export const DIMENSIONS = [
  ['CORRECTNESS', 'does it do the right thing, in the right place (BUG, CLAIM)'],
  ['FIT', 'does it follow the conventions and the similar code nearby (DESIGN)'],
  ['SENSE', 'is every edit needed for what the change is for (SCOPE, CLAIM)'],
  ['CLEAN', 'Clean Code rules in the new and edited code (CLEAN)'],
  [
    'PITFALLS',
    'security, performance, concurrency, error paths, compatibility (SECURITY, PERF, CONCURRENCY, ERRPATH, COMPAT)',
  ],
  ['MISSING', 'changes the diff needs but does not contain (MISSING)'],
  ['TESTS', 'tests for the changed behaviour, and their quality (TEST, FLAKY)'],
  ['SMELLS', 'duplication, dead code, long or unclear code (REDUNDANT, CLEAN)'],
] as const;

export const ATTESTATION_DIRECTIVE = `For each dimension, write one \`attestations\` entry, in this order, saying what you examined: "D<n> NAME: ISSUES — …" when you report a finding for it, else "D<n> NAME: NONE — what you checked, path:line". The dimensions:
${DIMENSIONS.map(([name, what], i) => `- D${i + 1} ${name}: ${what}`).join('\n')}`;

export function attestationChecks(findings: string): AcceptanceCheck[] {
  return [
    {
      expr: `len(unmatched(attestations, "^D[0-9]+ [A-Z]+: (ISSUES|NONE) — .")) == 0 && heads(attestations, "^D[0-9]+ [A-Z]+: ") == [${DIMENSIONS.map(([name], i) => JSON.stringify(`D${i + 1} ${name}: `)).join(', ')}]`,
      message: `Write one attestations entry per dimension, in order: ${DIMENSIONS.map(([n], i) => `D${i + 1} ${n}`).join(', ')}, each "D<n> NAME: ISSUES — …" or "D<n> NAME: NONE — what you checked".`,
    },
    {
      expr: `count(attestations, ": ISSUES — ") == 0 || len(${findings}) > 0`,
      message: 'An attestation says ISSUES: write those issues as findings.',
    },
  ];
}

/** Attestations for a scripted answer: ISSUES for the dimensions named, NONE for the rest. */
export const attest = (issues: readonly string[] = []): string[] =>
  DIMENSIONS.map(([name], i) =>
    issues.includes(name)
      ? `D${i + 1} ${name}: ISSUES — see the findings`
      : `D${i + 1} ${name}: NONE — read the changed lines for it`,
  );

/** A check that a step's honest "failed" answer is spared: what it checks was not done. */
export const orFailed = (c: AcceptanceCheck): AcceptanceCheck => ({
  expr: `verdict.outcome == "failed" || (${c.expr})`,
  message: c.message,
});
