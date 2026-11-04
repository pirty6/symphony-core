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
  ];
}
