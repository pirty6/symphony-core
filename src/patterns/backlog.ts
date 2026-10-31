import type { Pattern } from '../core/types.js';

const v = (reason: string) => ({
  outcome: 'applied' as const,
  confidence: 0.9,
  shouldTerminate: false,
  reason,
});

/** Most items one backlog run queues; each one is a full implement/fix run. */
export const MAX_BACKLOG_ITEMS = 10;

/**
 * Backlog = turn a document of improvements (or an investigate result) into
 * self-contained requests, let you pick which to play, then play `runPattern`
 * once per pick. Each item is its own run (own worktree, approvals, PR review);
 * the runtime starts them in order (core/chain followUps) and a failed item
 * does not stop the rest.
 */
export const backlog: Pattern = {
  name: 'backlog',
  description:
    'Turn an improvements document into separate requests, pick the ones to do, then implement (or fix) each one as its own run.',
  verbTriggers: ['backlog', 'improvements', 'roadmap', 'todo list', 'each item'],
  requiredContext: ['source'],
  goalFrom: 'source',
  result: ['items', 'queue', 'runPattern'],
  state: [
    {
      name: 'source',
      type: 'string',
      description: 'The improvements: a file path in the workspace, or the text itself',
    },
    {
      name: 'runPattern',
      type: 'string',
      description: 'Pattern to play for each item: implement (default), fix or refactor',
    },
    {
      name: 'testCommand',
      type: 'string',
      description: 'Optional: the test command every item run uses',
    },
    {
      name: 'items',
      type: 'string[]',
      description: 'One self-contained request per entry, most valuable first',
    },
    {
      name: 'picks',
      type: 'string[]',
      description: 'Item numbers to play, e.g. 1, 3 (empty = all)',
    },
    { name: 'queue', type: 'string[]', description: 'The requests that will play, in order' },
    {
      name: 'pickProblem',
      type: 'string',
      description: 'Why the last picks could not be used',
    },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'hasPattern',
      kind: 'condition',
      label: 'Pattern given?',
      expression: 'len(runPattern) > 0',
    },
    {
      id: 'defaultPattern',
      kind: 'compute',
      label: 'Use implement',
      assign: [{ field: 'runPattern', expr: '"implement"' }],
    },
    {
      id: 'knownPattern',
      kind: 'condition',
      label: 'Playable?',
      expression: 'runPattern == "implement" || runPattern == "fix" || runPattern == "refactor"',
    },
    {
      id: 'extract',
      kind: 'agent',
      role: 'assessor',
      label: 'Extract items',
      directive: `If \`source\` names a file in the workspace, read it; otherwise \`source\` is the text itself. Turn each actionable improvement into one self-contained request that someone could carry out without the document: what to change, where (files or modules it names), and how to tell it is done. Check the code: skip what is already done, vague wishes and duplicates. Split items that bundle unrelated changes. At most ${MAX_BACKLOG_ITEMS}, most valuable first.`,
      reads: ['source', 'runPattern'],
      writes: ['items'],
      checks: [
        {
          expr: `len(items) <= ${MAX_BACKLOG_ITEMS}`,
          message: `Keep the ${MAX_BACKLOG_ITEMS} most valuable items.`,
        },
      ],
    },
    { id: 'hasItems', kind: 'condition', label: 'Anything to do?', expression: 'len(items) > 0' },
    {
      id: 'choose',
      kind: 'approval',
      label: 'Pick items',
      message:
        'Each item plays as its own run, one after another. Enter the item numbers to play (e.g. 1, 3) or leave empty for all; reject to play none.',
      writes: ['picks'],
      shows: ['items', 'runPattern', 'pickProblem'],
      maxVisits: 4,
    },
    {
      id: 'validPicks',
      kind: 'condition',
      label: 'Valid numbers?',
      // Every pick names an item, and none twice: nothing is dropped or played twice silently.
      expression: 'len(pick(items, picks)) == len(picks) && len(unique(picks)) == len(picks)',
    },
    {
      id: 'rejectPicks',
      kind: 'compute',
      label: 'Ask again',
      assign: [
        {
          field: 'pickProblem',
          expr: '"Use each item number once (1 is the first item); got: " + join(picks, ", ")',
        },
      ],
    },
    { id: 'picked', kind: 'condition', label: 'Picked some?', expression: 'len(picks) > 0' },
    {
      id: 'queuePicks',
      kind: 'compute',
      label: 'Queue picks',
      assign: [{ field: 'queue', expr: 'pick(items, picks)' }],
    },
    {
      id: 'queueAll',
      kind: 'compute',
      label: 'Queue all',
      assign: [{ field: 'queue', expr: 'items' }],
    },
    { id: 'hasQueue', kind: 'condition', label: 'Queue empty?', expression: 'len(queue) > 0' },
    // Success here means the items are queued; each one's own run says how it went.
    {
      id: 'queued',
      kind: 'end',
      label: 'Items queued (each plays as its own run)',
      outcome: 'success',
    },
    { id: 'nothing', kind: 'end', label: 'Nothing to do', outcome: 'success' },
    { id: 'badPick', kind: 'end', label: 'No valid item numbers', outcome: 'failed' },
    { id: 'unknown', kind: 'end', label: 'Unknown pattern', outcome: 'failed' },
  ],
  edges: [
    { id: 'start-hasPattern', from: 'start', to: 'hasPattern' },
    { id: 'hasPattern-known', from: 'hasPattern', to: 'knownPattern', branch: 'then' },
    { id: 'hasPattern-default', from: 'hasPattern', to: 'defaultPattern', branch: 'else' },
    { id: 'defaultPattern-known', from: 'defaultPattern', to: 'knownPattern' },
    { id: 'known-extract', from: 'knownPattern', to: 'extract', branch: 'then' },
    { id: 'known-unknown', from: 'knownPattern', to: 'unknown', branch: 'else' },
    { id: 'extract-hasItems', from: 'extract', to: 'hasItems' },
    { id: 'hasItems-choose', from: 'hasItems', to: 'choose', branch: 'then' },
    { id: 'hasItems-nothing', from: 'hasItems', to: 'nothing', branch: 'else' },
    { id: 'choose-picked', from: 'choose', to: 'picked' },
    { id: 'picked-valid', from: 'picked', to: 'validPicks', branch: 'then' },
    { id: 'valid-picks', from: 'validPicks', to: 'queuePicks', branch: 'then' },
    { id: 'valid-reject', from: 'validPicks', to: 'rejectPicks', branch: 'else' },
    { id: 'reject-choose', from: 'rejectPicks', to: 'choose', label: 'ask again' },
    { id: 'picked-all', from: 'picked', to: 'queueAll', branch: 'else' },
    { id: 'queuePicks-hasQueue', from: 'queuePicks', to: 'hasQueue' },
    { id: 'queueAll-hasQueue', from: 'queueAll', to: 'hasQueue' },
    { id: 'hasQueue-queued', from: 'hasQueue', to: 'queued', branch: 'then' },
    { id: 'hasQueue-bad', from: 'hasQueue', to: 'badPick', branch: 'else' },
  ],
  demo: {
    goal: 'Apply the improvements in docs/improvements.md',
    context: { source: 'docs/improvements.md', runPattern: 'implement' },
    agents: {
      extract: () => ({
        updates: {
          items: [
            'Add a --json flag to `symphony list` that prints the patterns as JSON; done when the CLI test parses it.',
            'Show the premium requests of a run in the studio result panel; done when the panel test sees them.',
          ],
        },
        verdict: v('2 items'),
      }),
    },
  },
};
