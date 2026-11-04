/**
 * Two versions of a run's result, one for each reader:
 *
 * - `summary`, for people: an AI rewords what the run decided in ASD-STE100 Simplified
 *   Technical English (short sentences, common words, terms explained, no ids), checked by the
 *   engine. The `plainSummary` switch (on) turns it off, saving one model call.
 * - `handoff`, for an AI agent: the engine writes it from the record, most important first,
 *   with instructions. Complete and the same every time; a chained run gets it whole.
 *
 * A pattern with several ends marks which one it reached, runs the readers once, then routes
 * to that end (`readers().to(end)` replaces an edge's target).
 */
import type { AcceptanceCheck, ScoreEdge, ScoreNode, StateField } from '../../core/types.js';

/** A list as Markdown bullets, or "none" (an expression). */
export const bullets = (list: string) =>
  `if(len(${list}) == 0, "none", "- " + join(${list}, "\n- "))`;

export const READER_STATE: readonly StateField[] = [
  {
    name: 'plainSummary',
    type: 'boolean',
    initial: true,
    description: 'Start the result with a short version for people (Simplified Technical English)',
  },
  {
    name: 'summary',
    type: 'string',
    description: 'The result for people: short, plain English, no citation ids',
  },
  {
    name: 'handoff',
    type: 'string',
    description:
      'The result for an AI agent: everything found, cited, with instructions (by the engine)',
  },
];

/** The sections of the people's version, in order. */
export const PLAIN_SECTIONS = [
  '## In short',
  '## What we found',
  '## What to do',
  '## What is not certain',
  '## How we checked',
] as const;

/** What the AI is told for the people's version: the rules of ASD-STE100, and its sections. */
export function plainDirective(about: string, sources: readonly string[]): string {
  return [
    `Write \`summary\`: ${about}, for a reader with no prior knowledge of the project. Use only what ${sources.map((s) => `\`${s}\``).join(', ')} say. Add nothing, and leave out nothing that changes the conclusion. Keep every number exact.`,
    'Write in Simplified Technical English (ASD-STE100):',
    '- One idea in each sentence. Descriptive sentences have at most 25 words, instructions at most 20. Paragraphs have at most 6 sentences.',
    '- Use the active voice and simple tenses. Write instructions as commands ("Run the tests.").',
    '- Use common words, and use one word for one thing (do not change between "run", "execution" and "job").',
    '- The first time you use a technical term, explain it in a few plain words. Do not use abbreviations without explaining them.',
    '- Do not use citation ids ([F12]), file paths with line numbers, or hypothesis ids (H1). The AI version keeps them.',
    'Use these Markdown sections, in this order:',
    '## In short: the result in 2 or 3 sentences.',
    '## What we found: a list of the main facts, each one sentence.',
    '## What to do: numbered steps, one command each, only if there are actions for the reader. Leave this section out if there are none.',
    '## What is not certain: a list of what is still open or unsure, each one sentence; "Nothing." if all is settled.',
    '## How we checked: 1 to 3 sentences on what was examined (code, history, web pages, tests).',
  ].join('\n');
}

export const PLAIN_CHECKS: readonly AcceptanceCheck[] = [
  { expr: 'len(summary) > 0', message: 'Write the summary.' },
  {
    expr: 'len(longSentences(summary, 25)) == 0',
    message: 'Make each sentence 25 words or fewer: split long sentences into two.',
  },
  {
    expr: 'len(refs(summary)) == 0',
    message: 'Leave out citation ids like [F12]: the AI version keeps them.',
  },
  {
    expr: 'includes(summary, "## In short") && includes(summary, "## What we found") && includes(summary, "## What is not certain") && includes(summary, "## How we checked")',
    message:
      'Use the sections ## In short, ## What we found, ## What is not certain and ## How we checked (and ## What to do when there are actions).',
  },
];

/** The step that marks an end, before the readers run. */
const mark = (end: string) => `mark_${end}`;

export interface Readers {
  readonly nodes: readonly ScoreNode[];
  readonly edges: readonly ScoreEdge[];
  /** Where to go instead of `end`: it marks the end, the readers run, then it is reached. */
  readonly to: (end: string) => string;
  /** An edge list with every edge into one of the ends sent through the readers. */
  readonly route: (edges: readonly ScoreEdge[]) => ScoreEdge[];
}

/**
 * The readers' steps for a pattern: `handoff` is the expression of its AI brief, which may use
 * `status` (the end reached, by id); `about` and `sources` tell the AI what to reword.
 */
export function readers(o: {
  readonly handoff: string;
  readonly about: string;
  readonly sources: readonly string[];
  /** The ends the readers run before, in the order they are tested (the last is the default). */
  readonly ends: readonly { readonly id: string; readonly label: string }[];
  /** State field that holds the end reached. */
  readonly status: string;
}): Readers {
  const ends = o.ends;
  const nodes: ScoreNode[] = [
    ...ends.map(
      (e): ScoreNode => ({
        id: mark(e.id),
        kind: 'compute',
        label: `Ending: ${e.label}`,
        assign: [{ field: o.status, expr: JSON.stringify(e.id) }],
      }),
    ),
    {
      id: 'handoffDoc',
      kind: 'compute',
      label: 'Write the AI version',
      // From the record, not by the AI: complete and the same every time.
      assign: [{ field: 'handoff', expr: o.handoff }],
    },
    { id: 'wantPlain', kind: 'condition', label: 'Plain summary?', expression: 'plainSummary' },
    {
      id: 'explain',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Write the version for people',
      // Rewording what is already decided: a cheaper tier does it well.
      complexityShift: -1,
      directive: plainDirective(o.about, o.sources),
      reads: [...o.sources],
      writes: ['summary'],
      retries: 2,
      checks: [...PLAIN_CHECKS],
    },
    ...ends.slice(0, -1).map(
      (e): ScoreNode => ({
        id: `endIs_${e.id}`,
        kind: 'condition',
        label: `${e.label}?`,
        expression: `${o.status} == ${JSON.stringify(e.id)}`,
      }),
    ),
  ];
  const first = ends.length > 1 ? `endIs_${ends[0]!.id}` : ends[0]!.id;
  const edges: ScoreEdge[] = [
    ...ends.map((e) => ({ id: `${mark(e.id)}-handoff`, from: mark(e.id), to: 'handoffDoc' })),
    { id: 'handoff-wantPlain', from: 'handoffDoc', to: 'wantPlain' },
    { id: 'wantPlain-explain', from: 'wantPlain', to: 'explain', branch: 'then' },
    { id: 'wantPlain-route', from: 'wantPlain', to: first, branch: 'else' },
    { id: 'explain-route', from: 'explain', to: first },
    ...ends.slice(0, -1).flatMap((e, i) => [
      { id: `endIs_${e.id}-yes`, from: `endIs_${e.id}`, to: e.id, branch: 'then' as const },
      {
        id: `endIs_${e.id}-no`,
        from: `endIs_${e.id}`,
        to: i + 2 < ends.length ? `endIs_${ends[i + 1]!.id}` : ends.at(-1)!.id,
        branch: 'else' as const,
      },
    ]),
  ];
  const ids = new Set(ends.map((e) => e.id));
  return {
    nodes,
    edges,
    to: mark,
    route: (list) => list.map((e) => (ids.has(e.to) ? { ...e, to: mark(e.to) } : e)),
  };
}
