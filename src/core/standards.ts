/**
 * The code standard every step that writes or reviews code is held to: the practices of
 * "Clean Code" (Robert C. Martin, 2008), summarized in our own words, one rule per chapter's
 * main point. The codebase's own conventions come first where the two disagree, and a change
 * stays scoped to its task.
 */
import type { AgentNode, CodeStandardMode } from './types.js';

export const CLEAN_CODE_RULES: readonly string[] = [
  'Names (ch. 2) reveal intent: a reader knows what a variable holds or a function does without reading its body. No misleading names, encodings or cute words; one word per concept; names from the problem or the solution domain.',
  'Functions (ch. 3) are small and do one thing, at one level of abstraction, and read top-down. Few arguments (group many into an object); no boolean flag arguments; no output arguments; no hidden side effects; a function either does something or answers something, not both.',
  'No duplication (ch. 3, 12): reuse or extract the existing helper instead of copying logic.',
  'Errors (ch. 7): throw (or return a typed failure) with context instead of error codes; keep error handling in its own function; never swallow an error; do not return or pass null where a value is expected.',
  'Comments (ch. 4) say why, warn, or clarify what code cannot. Explain in code first (a better name, a small function). No redundant, misleading, journal or noise comments, and no commented-out code.',
  'Formatting (ch. 5): follow the project formatter and team rules; keep related code close, callers above callees, variables declared near their use.',
  'Objects and data (ch. 6): hide internals behind behaviour; talk to direct collaborators only (no a.b().c().d() chains); a type is either an object with behaviour or a plain data structure, not half of each.',
  'Boundaries (ch. 8): wrap third-party APIs behind your own interface at one place, so a change there touches one file.',
  'Classes and modules (ch. 10) are small and cohesive, with one reason to change; depend on abstractions, and organise so a new case adds code rather than editing old code.',
  'Systems (ch. 11): separate building objects from using them (pass dependencies in); keep cross-cutting concerns (logging, retries, transactions) out of the business logic.',
  'Simple design (ch. 12), in order: all the tests pass, no duplication, the code says what it means, as few classes and functions as that allows.',
  'Concurrency (ch. 13): keep concurrent code apart from the rest; limit and copy shared data; keep locked sections small; make shutdown correct; treat a one-off failure as a possible race, not noise.',
  'Tests (ch. 9) are clean code too: readable, one concept per test, and F.I.R.S.T.: fast, independent, repeatable, self-validating (they assert), timely (written with the code).',
  'Leave the code you touch a little cleaner than you found it (ch. 1), but do not refactor code outside the task.',
];

/**
 * The rule ids a reviewer names in a CLEAN finding: the smells and heuristics of Clean Code
 * ch. 17 (comments C, environment E, functions F, general G, names N, tests T), each glossed in
 * our own words, plus the F.I.R.S.T. test qualities of ch. 9. The ids are checked against the
 * book.
 */
export const CLEAN_CODE_IDS: readonly (readonly [id: string, gloss: string])[] = [
  ['C1', 'a comment holding what belongs elsewhere (history, authors, tickets)'],
  ['C2', 'a comment that no longer matches the code'],
  ['C3', 'a comment that only repeats the code'],
  ['C4', 'a careless, unclear comment'],
  ['C5', 'commented-out code left in'],
  ['E1', 'building needs more than one step'],
  ['E2', 'running the tests needs more than one step'],
  ['F1', 'too many arguments (more than three)'],
  ['F2', 'an output argument: the function writes into what it was given'],
  ['F3', 'a boolean flag argument: the function does two things'],
  ['F4', 'a function nothing calls'],
  ['G1', 'several languages mixed in one source file'],
  ['G2', 'behaviour a reader would expect is missing'],
  ['G3', 'wrong behaviour at a boundary (empty, zero, last item, limits)'],
  ['G4', 'a safety turned off (a check, warning, test or lint rule disabled)'],
  ['G5', 'duplicated logic that an existing or shared helper should hold'],
  ['G6', 'code at the wrong level of abstraction'],
  ['G7', 'a base type that depends on its subtypes'],
  ['G8', 'a module exposes more than callers need'],
  ['G9', 'dead code'],
  ['G10', 'a declaration far from where it is used'],
  ['G11', 'inconsistent with how the same thing is done nearby'],
  ['G12', 'clutter: unused variables, empty defaults, pointless code'],
  ['G13', 'coupling two things that need not know each other'],
  ['G14', "feature envy: the code works mostly on another object's data"],
  ['G15', 'a selector argument that picks what the function does'],
  ['G16', 'obscured intent: dense or clever code the reader must decode'],
  ['G17', 'a responsibility placed in the wrong module'],
  ['G18', 'a static function that should belong to an object'],
  ['G19', 'a complex expression with no explanatory variable'],
  ['G20', 'a function name that does not say what it does'],
  ['G21', 'code that works by trial, without understanding why'],
  ['G22', 'a dependency assumed but not expressed in code'],
  ['G23', 'a type switch or if-chain that polymorphism should replace'],
  ['G24', "the project's or language's conventions not followed"],
  ['G25', 'a magic number or string without a name'],
  ['G26', 'imprecise code: a lazy assumption (float money, ignored concurrency, unchecked null)'],
  ['G27', 'a convention relied on where structure could enforce it'],
  ['G28', 'a complex condition not given a name'],
  ['G29', 'a negative condition where a positive one reads better'],
  ['G30', 'a function that does more than one thing'],
  ['G31', 'a hidden order dependency between calls'],
  ['G32', 'an arbitrary structure with no reason a reader can see'],
  ['G33', 'boundary arithmetic (+1, -1) spread around instead of named once'],
  ['G34', 'a function that mixes levels of abstraction'],
  ['G35', 'configuration buried deep instead of at the top level'],
  ['G36', 'a chain through other objects (talk to direct collaborators)'],
  ['N1', 'a name that does not say what it holds or does'],
  ['N2', 'a name tied to how, at the wrong level of abstraction'],
  ['N3', 'a home-made name where a standard one exists'],
  ['N4', 'an ambiguous name'],
  ['N5', 'a short name for a long scope'],
  ['N6', 'a name with a type or scope encoding'],
  ['N7', 'a name that hides a side effect'],
  ['T1', 'behaviour the tests do not check'],
  ['T2', 'coverage not measured where gaps are likely'],
  ['T3', 'a trivial case left untested'],
  ['T4', 'a skipped or ignored test with no reason'],
  ['T5', 'boundary conditions not tested'],
  ['T6', 'no extra tests near a bug just fixed'],
  ['T7', 'test failures not used to find the pattern of a bug'],
  ['T8', 'coverage gaps not used to find untested paths'],
  ['T9', 'a slow test'],
  ['FIRST-F', 'a slow test (F.I.R.S.T.: fast)'],
  ['FIRST-I', 'tests that depend on each other or on order (independent)'],
  ['FIRST-R', 'a test that is not repeatable: clock, network, randomness (repeatable)'],
  ['FIRST-S', 'a test that does not check its own result (self-validating)'],
  ['FIRST-T', 'tests written long after the code they test (timely)'],
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
