/**
 * The code standard every step that writes or reviews code is held to: the practices of
 * "Clean Code" (Robert C. Martin), summarized. The codebase's own conventions come first
 * where the two disagree, and a change stays scoped to its task.
 */
import type { AgentNode, CodeStandardMode } from './types.js';

export const CLEAN_CODE_RULES: readonly string[] = [
  'Names reveal intent: a reader knows what a variable holds or a function does without reading its body. No abbreviations, encodings or misleading names.',
  'Functions are small and do one thing, at one level of abstraction. Few arguments; no boolean flag arguments (split the function instead).',
  'No hidden side effects: a function either does something or answers something, not both.',
  'No duplication: reuse or extract the existing helper instead of copying logic.',
  'Errors: throw or return a typed failure with context; never swallow an error, and do not return or pass null where a value is expected.',
  'Comments say why, not what. Delete commented-out code and comments that repeat the code; prefer a better name over a comment.',
  'Classes and modules have one reason to change; keep related code together and talk to direct collaborators only (no long chains through other objects).',
  'Tests are clean code too: readable, one concept per test, fast, independent, repeatable, self-checking.',
  'Leave the code you touch a little cleaner than you found it, but do not refactor code outside the task.',
];

/**
 * The rule ids a reviewer names in a CLEAN finding: a short, high-signal subset of the smells
 * and heuristics catalogue of Clean Code ch. 17 (comments C, environment E, functions F,
 * general G, names N, tests T), glossed in our own words, plus the F.I.R.S.T. test qualities.
 * The ids follow public transcriptions of the chapter; the book's own pages were not checked.
 */
export const CLEAN_CODE_IDS: readonly (readonly [id: string, gloss: string])[] = [
  ['C2', 'a comment that no longer matches the code'],
  ['C3', 'a comment that only repeats the code'],
  ['C5', 'commented-out code left in'],
  ['F1', 'too many arguments (more than three)'],
  ['F2', 'an output argument: the function writes into what it was given'],
  ['F3', 'a boolean flag argument: the function does two things'],
  ['F4', 'a function nothing calls'],
  ['G2', 'behaviour a reader would expect is missing'],
  ['G3', 'wrong behaviour at a boundary (empty, zero, last item, limits)'],
  ['G4', 'a safety turned off (a check, warning, test or lint rule disabled)'],
  ['G5', 'duplicated logic that an existing or shared helper should hold'],
  ['G6', 'code at the wrong level of abstraction'],
  ['G8', 'a module exposes more than callers need'],
  ['G9', 'dead code'],
  ['G11', 'inconsistent with how the same thing is done nearby'],
  ['G14', "feature envy: the code works mostly on another object's data"],
  ['G16', 'obscured intent: dense or clever code the reader must decode'],
  ['G17', 'a responsibility placed in the wrong module'],
  ['G23', 'a type switch or if-chain that polymorphism should replace'],
  ['G25', 'a magic number or string without a name'],
  ['G28', 'a complex condition not given a name'],
  ['G29', 'a negative condition where a positive one reads better'],
  ['G30', 'a function that does more than one thing'],
  ['G31', 'a hidden order dependency between calls'],
  ['G34', 'a function that mixes levels of abstraction'],
  ['G36', 'a chain through other objects (talk to direct collaborators)'],
  ['N1', 'a name that does not say what it holds or does'],
  ['N4', 'an ambiguous name'],
  ['N7', 'a name that hides a side effect'],
  ['T1', 'behaviour the tests do not check'],
  ['T3', 'a trivial case left untested'],
  ['T4', 'a skipped or ignored test with no reason'],
  ['T5', 'boundary conditions not tested'],
  ['T6', 'no extra tests near a bug just fixed'],
  ['FIRST-F', 'a slow test'],
  ['FIRST-I', 'tests that depend on each other or on order'],
  ['FIRST-R', 'a test that is not repeatable (clock, network, randomness)'],
  ['FIRST-S', 'a test that does not check its own result (no assertion)'],
];

/** Pulls the rule id out of a CLEAN finding: the first bracketed catalogue-shaped token. */
export const CLEAN_ID_PATTERN = '[[]([CEFGNT][0-9]+|FIRST-[FIRST])]';

/** Executors with workspace tools write code to the standard; `reviewsCode` steps review against it. */
export function codeStandardFor(node: AgentNode): CodeStandardMode | undefined {
  if (node.reviewsCode) return 'review';
  return node.role === 'executor' && !node.isolated ? 'write' : undefined;
}

/** The prompt section for a step held to the standard. */
export function codeStandardSection(mode: CodeStandardMode): string[] {
  return [
    '## Code standard: Clean Code (Robert C. Martin)',
    mode === 'write'
      ? 'Every line of code you write or change follows these practices. Where the codebase has its own conventions (AGENTS.md, linters, nearby code), follow those first.'
      : 'Judge the code under review against these practices, as well as for correctness. A clear break of one in the code the change adds or edits is an issue to report, at the line, with the rule it breaks; code the change did not touch is not. Where the codebase has its own conventions (AGENTS.md, linters, nearby code), those come first.',
    ...CLEAN_CODE_RULES.map((r) => `- ${r}`),
    ...(mode === 'review'
      ? [
          'Name the rule a CLEAN finding breaks by its id, in brackets after the severity ("[CLEAN] [MEDIUM] [G5] …"). The ids:',
          ...CLEAN_CODE_IDS.map(([id, gloss]) => `- ${id}: ${gloss}`),
        ]
      : []),
  ];
}
