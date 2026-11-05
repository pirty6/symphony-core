/**
 * Names shared by every surface (runtime, studio, integrations), kept in one
 * browser-safe place. The runtime's tool registry must match TOOL_OUTPUTS: a test
 * fails when they drift.
 */
import type { Complexity, StateField } from './types.js';

/** Demo games: runnable in the studio and CLI, but never offered as a route for real work. */
export const DEMO_ONLY: ReadonlySet<string> = new Set(['hangman']);

/** The built-in tools and what each one returns (src/runtime/builtin-tools.ts). */
export const TOOL_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  'repo.files': ['files', 'excluded'],
  'repo.rank': ['ranked', 'matched'],
  'paths.resolve': ['files', 'reasons', 'unmatched', 'over'],
  'sources.catalog': ['names', 'descriptions'],
  'tests.run': ['passed', 'output', 'command'],
  'git.diff': ['diff', 'hash', 'files'],
  'git.pr': ['number', 'base', 'files', 'paths', 'error'],
  'diff.scan': ['diff', 'smells', 'masking', 'error'],
  'files.read': ['files'],
  'evidence.check': ['valid', 'invalid', 'checked'],
  'evidence.context': ['items'],
  'memory.facts': ['saved'],
  'memory.recall': ['facts', 'lessons'],
  'memory.lesson': ['saved'],
  'patterns.list': ['names', 'summaries', 'catalog'],
  'patterns.route': ['suggested', 'matches'],
  'pattern.validate': ['errors', 'valid', 'pattern', 'inputs'],
  'compositions.recall': ['exact', 'similar'],
  'compositions.remember': ['saved'],
  'pattern.outline': ['steps', 'settings'],
  'pattern.save': ['file', 'name'],
};

/** What each complexity tier means, in a word or two. */
export const TIER_NAMES: Readonly<Record<Complexity, string>> = {
  1: 'routine',
  2: 'some judgement',
  3: 'risky',
  4: 'novel',
};

/** One choice of a feature switch: the state value, and how it reads. */
export interface FeatureChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * Settings that turn behaviour on or off, as opposed to tuning a number: the studio lists the
 * ones the open pattern has, and each is the pattern's own state field (an input of the run).
 * Without `choices` the field is a boolean.
 */
export interface Feature {
  readonly field: string;
  readonly label: string;
  readonly description: string;
  readonly choices?: readonly FeatureChoice[];
}

export const FEATURES: readonly Feature[] = [
  {
    field: 'lean',
    label: 'Lean run',
    description:
      'On by default: one debate round, single-pass triage, gap-aimed research, unchallenged sub-answers kept, a sub-agent per gap, and an AI-rated complexity (by the investigation or the maestro) capped at 3; one you set stays. About a third less time and a quarter fewer tokens (estimated). Turn it off if answers get worse; the switches below then apply one by one.',
  },
  {
    field: 'supportJudge',
    label: 'Support judge',
    description:
      "Another model family checks that each cited finding's quote backs its claim. Shadow reports and keeps unsupported findings out of memory; enforce also makes the answer partial. Off until calibrated.",
    choices: [
      { value: 'off', label: 'off' },
      { value: 'shadow', label: 'shadow' },
      { value: 'enforce', label: 'enforce' },
    ],
  },
  {
    field: 'singlePass',
    label: 'Single-pass triage (pilot)',
    description:
      'Triage also reads relevant files in depth; those the engine shows it gave whole skip the deep read.',
  },
  {
    field: 'readerHypotheses',
    label: 'Hypotheses to evidence readers',
    description:
      'Readers look for evidence for and against each hypothesis and tag findings. Off: an ablation (assess, the answer and the debate keep them).',
  },
  {
    field: 'keepUnchallenged',
    label: 'Keep unchallenged sub-answers',
    description:
      'After a challenge, the rewrite keeps word for word the sub-answers no objection named (an A/B option).',
  },
  {
    field: 'pragmatistFrom',
    label: 'Pragmatist from complexity',
    description:
      "The complexity from which a pragmatist triages the skeptic's objections (2 is a trial).",
    choices: [
      { value: '2', label: '2' },
      { value: '3', label: '3' },
      { value: '4', label: '4' },
    ],
  },
  {
    field: 'gapsPerChase',
    label: 'Gap research',
    description:
      'One call researches every gap, or each gap gets its own sub-agent (faster, more tokens).',
    choices: [
      { value: '99', label: 'one call' },
      { value: '1', label: 'one sub-agent per gap' },
    ],
  },
  {
    field: 'maxExpandRounds',
    label: 'Gap expansion',
    description:
      'Gaps send the unread workspace files that share their words to the deep read, up to this many rounds.',
    choices: [
      { value: '0', label: 'off' },
      { value: '1', label: '1 round' },
      { value: '2', label: '2 rounds' },
    ],
  },
  {
    field: 'reproduceFirst',
    label: 'Reproduce the bug first',
    description:
      'Before the fix, a test that reproduces the bug is written, proved to fail for the right reason, and locked; the fix must leave it unchanged.',
  },
  {
    field: 'hypothesesPerResearch',
    label: 'Fix research',
    description:
      'One call researches every hypothesis, or each gets its own sub-agent (sooner, more tokens; a trial).',
    choices: [
      { value: '99', label: 'one call' },
      { value: '1', label: 'one sub-agent per hypothesis' },
    ],
  },
  {
    field: 'plainSummary',
    label: 'Plain summary',
    description:
      'On by default: the result starts with a short version for people, in Simplified Technical English (short sentences, common words, no citation ids), written from the cited answer. The full version for AI agents is always there. Off saves one model call.',
  },
  {
    field: 'verify',
    label: 'Run the tests (review)',
    description:
      "Off by default: the PR's CI pipeline already runs the tests and lint. On: the engine runs the tests (and the lint command, if set) on the reviewed code, and failing tests are an issue.",
  },
  {
    field: 'narrowRead',
    label: 'Narrowed read (opt-in)',
    description:
      'Where every file would be triaged (up to 300 files, or exhaustive): triage only the files the search matched plus 20 more in ranked order. Every other file is never read (zero coverage) and is listed in the coverage. Only when you accept that. A bigger repository is already narrowed by Locate.',
  },
  {
    field: 'gapAimed',
    label: 'Gap-aimed research (pilot)',
    description:
      'Gap research gets what the gap check says is missing instead of the whole sub-question.',
  },
];

/**
 * The switches chosen (as the studio keeps them: strings) as inputs of a run of this pattern:
 * only its own fields, only values the switch allows, typed as its state says.
 */
export function featureInputs(
  pattern: { readonly state: readonly StateField[] },
  chosen: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FEATURES) {
    const field = pattern.state.find((s) => s.name === f.field);
    const value = chosen[f.field];
    if (!field || value === undefined) continue;
    if (!f.choices) {
      if (field.type === 'boolean' && (value === 'true' || value === 'false'))
        out[f.field] = value === 'true';
      continue;
    }
    if (!f.choices.some((c) => c.value === value)) continue;
    if (field.type === 'number') out[f.field] = Number(value);
    else if (field.type === 'string') out[f.field] = value;
  }
  return out;
}
