import { draftInstructions } from '../../core/draft.js';
import type { Pattern } from '../../core/types.js';

const v = (reason: string) => ({
  outcome: 'applied' as const,
  confidence: 0.85,
  shouldTerminate: false,
  reason,
});

/**
 * How a metaphor becomes a model, in Symphony's own terms. Each part of a
 * metaphor has one way to become part of a workflow, so different metaphors
 * become different workflows by the same rules.
 */
export const METAPHOR_RULES = [
  'Voice: each frame or perspective becomes its own agent node writing its OWN state field (assessor when it senses or reads, executor when it changes something); no voice overwrites another.',
  'Tension: each "A vs B" becomes a condition choosing between their paths, or a loop between them bounded by a counter and a max.',
  'Pulse: rhythm, repetition or listening over time becomes a loop with a round counter and a maximum.',
  'Filter: selecting what "fits" becomes agent checks or a condition over a field; say what passes and what is kept anyway.',
  'Coexistence: holding things together becomes a compute node that combines fields without dropping any.',
  'Ground: stillness, the calm center, what is given becomes an early step that reads the input (a tool node or an assessor).',
  'Judgement: feeling, deciding, sense-making by a person becomes an approval node.',
  "Resolution: how it ends becomes end nodes (success, and partial or failed for the other endings); `result` lists every voice's field, so no voice is dropped.",
] as const;

/**
 * Metaphor = read a metaphor (frames, tensions, movements), map it to a model
 * by METAPHOR_RULES, draft a pattern that embodies it, let the engine validate
 * it (the draft goes back with the errors, bounded), approve it, and save it
 * to src/patterns/drafts so the studio and the CLI can run it.
 */
export const metaphor: Pattern = {
  name: 'metaphor',
  description:
    'Turn a metaphor into a runnable Symphony pattern: read its frames and tensions, map them to a model, draft a pattern the engine validates, approve it, and save it to the library.',
  verbTriggers: [
    'metaphor',
    'metaphor to model',
    'from a metaphor',
    'symphony pattern',
    'new pattern',
  ],
  requiredContext: ['metaphor'],
  goalFrom: 'metaphor',
  result: ['patternName', 'savedFile', 'mapping', 'tensions', 'frames'],
  maxSteps: 80,
  state: [
    { name: 'metaphor', type: 'string', description: 'The metaphor, in your own words' },
    {
      name: 'purpose',
      type: 'string',
      description:
        'Optional: what the new pattern should do when it runs (e.g. read a market, review a design)',
    },
    { name: 'name', type: 'string', description: 'Optional: kebab-case name for the new pattern' },
    { name: 'names', type: 'string[]', description: 'Built-in pattern names (not to be reused)' },
    { name: 'summaries', type: 'string[]', description: 'What each built-in pattern does' },
    { name: 'frames', type: 'string[]', description: 'The perspectives or voices in the metaphor' },
    { name: 'tensions', type: 'string[]', description: '"A vs B — what is at stake"' },
    {
      name: 'movements',
      type: 'string[]',
      description: 'What happens, in order, as process steps',
    },
    {
      name: 'invariants',
      type: 'string[]',
      description: 'What must hold, e.g. "no single frame wins"',
    },
    {
      name: 'mapping',
      type: 'string[]',
      description:
        'One per part of the model: "rule: part of the metaphor → node kind id — what it does"',
    },
    { name: 'draft', type: 'object', description: 'The drafted pattern' },
    { name: 'draftErrors', type: 'string[]' },
    { name: 'draftValid', type: 'boolean' },
    { name: 'normalized', type: 'object', description: 'The validated pattern' },
    { name: 'rounds', type: 'number', description: 'Drafts sent back' },
    { name: 'maxRounds', type: 'number', initial: 3 },
    {
      name: 'feedback',
      type: 'string',
      description: 'Your changes to the draft (empty = save it)',
    },
    { name: 'revisions', type: 'number' },
    { name: 'maxRevisions', type: 'number', initial: 2 },
    { name: 'savedFile', type: 'string' },
    { name: 'patternName', type: 'string' },
  ],
  start: 'start',
  groups: [
    {
      id: 'readPhase',
      label: 'Read the metaphor',
      description: 'Its frames, tensions and movements, and the library it joins',
      nodes: ['catalog', 'read'],
    },
    {
      id: 'modelPhase',
      label: 'Metaphor to model',
      description: 'Each part of the metaphor mapped to a node by the same rules',
      nodes: ['map'],
    },
    {
      id: 'draftPhase',
      label: 'Draft and validate',
      description: 'The engine validates the draft; errors go back to it (bounded)',
      nodes: ['draft', 'validate', 'valid', 'sendBack', 'roundsLeft'],
    },
    {
      id: 'savePhase',
      label: 'Approve and save',
      description: 'You approve or ask for changes; the engine saves it to the library',
      nodes: ['approve', 'hasFeedback', 'revisionsLeft', 'revise', 'save'],
    },
  ],
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'catalog',
      kind: 'tool',
      label: 'Read the library',
      tool: 'patterns.list',
      output: { names: 'names', summaries: 'summaries' },
    },
    {
      id: 'read',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Read the metaphor',
      directive:
        'Read `metaphor` closely, in its own terms, without flattening it. Write its `frames` (the perspectives or voices it holds), its `tensions` ("A vs B — what is at stake"), its `movements` (what happens in it, in order, phrased as process steps someone could do) and its `invariants` (what must stay true for the metaphor to survive, e.g. "no single frame wins", "the edge is never discarded"). Keep the author\'s images; do not resolve its tensions.',
      reads: ['metaphor', 'purpose'],
      writes: ['frames', 'tensions', 'movements', 'invariants'],
      retries: 2,
      checks: [
        { expr: 'len(frames) > 0', message: 'Name at least one frame.' },
        { expr: 'len(tensions) > 0', message: 'Name at least one tension.' },
        { expr: 'len(movements) > 1', message: 'Describe the movements as steps, in order.' },
      ],
    },
    {
      id: 'map',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Map to a model',
      directive: `Map the metaphor to a workflow model by these rules, so any metaphor maps the same way:\n${METAPHOR_RULES.map((r) => `- ${r}`).join('\n')}\nWrite one \`mapping\` entry per part of the model, as "Rule: part of the metaphor → kind id — what it does", e.g. "Tension: filter vs immersion → condition fitsOrListens — keep listening while the pattern is not yet felt". Every tension and every frame must appear in some entry, and every invariant must be kept by some entry. If \`purpose\` is set, the model must do that when it runs; otherwise it works on a subject the user gives.`,
      reads: ['metaphor', 'purpose', 'frames', 'tensions', 'movements', 'invariants', 'summaries'],
      writes: ['mapping'],
      complexityShift: 1,
      retries: 2,
      checks: [
        { expr: 'len(mapping) >= len(tensions)', message: 'Map every tension.' },
        { expr: 'len(mapping) >= 3', message: 'Map the metaphor to at least 3 parts.' },
      ],
    },
    {
      id: 'draft',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Draft the pattern',
      maxVisits: 8,
      directive: `Draft the pattern that \`mapping\` describes: it must run on its own in Symphony studio, on one input the user supplies (in \`requiredContext\`, and \`goalFrom\` when that input states the goal), and do \`purpose\` if it is set. Build exactly the nodes in \`mapping\`, with directives in the metaphor's language but concrete about what to read and write. Keep \`invariants\`: e.g. if no frame may win, \`result\` lists every voice's field. Use \`name\` if given, else a new kebab-case name from the metaphor, not one of \`names\`. If \`draft\` holds an earlier round, revise it: fix every entry of \`draftErrors\` and apply \`feedback\`.

${draftInstructions()}

Put the whole pattern object in \`draft\`.`,
      reads: [
        'metaphor',
        'purpose',
        'name',
        'names',
        'frames',
        'tensions',
        'invariants',
        'mapping',
        'draft',
        'draftErrors',
        'feedback',
      ],
      writes: ['draft'],
      complexityShift: 1,
      retries: 2,
      checks: [{ expr: 'len(keys(draft)) > 0', message: 'Put the full pattern object in draft.' }],
    },
    {
      id: 'validate',
      kind: 'tool',
      label: 'Validate',
      tool: 'pattern.validate',
      inputs: { pattern: 'draft' },
      output: { errors: 'draftErrors', valid: 'draftValid', pattern: 'normalized' },
      maxVisits: 8,
    },
    {
      id: 'valid',
      kind: 'condition',
      label: 'Valid, new name?',
      expression: 'draftValid && !includes(names + ["maestro"], get(normalized, "name"))',
    },
    {
      id: 'sendBack',
      kind: 'compute',
      label: 'Send back',
      assign: [
        { field: 'rounds', expr: 'rounds + 1' },
        {
          field: 'draftErrors',
          expr: 'if(draftValid, ["the name is a built-in pattern: choose another"], draftErrors)',
        },
      ],
    },
    {
      id: 'roundsLeft',
      kind: 'condition',
      label: 'Draft again?',
      expression: 'rounds < maxRounds',
    },
    {
      id: 'approve',
      kind: 'approval',
      label: 'Approve the pattern',
      maxVisits: 4,
      message:
        'This is the pattern the metaphor became, and how each part maps. Approve with empty feedback to save it to the library (src/patterns/drafts), write feedback to get a revised draft, or reject to save nothing.',
      writes: ['feedback'],
      shows: ['mapping', 'tensions', 'invariants', 'normalized'],
    },
    { id: 'hasFeedback', kind: 'condition', label: 'Changes?', expression: 'len(feedback) > 0' },
    {
      id: 'revisionsLeft',
      kind: 'condition',
      label: 'Revise again?',
      expression: 'revisions < maxRevisions',
    },
    {
      id: 'revise',
      kind: 'compute',
      label: 'Revise',
      assign: [
        { field: 'revisions', expr: 'revisions + 1' },
        { field: 'draftErrors', expr: '[]' },
      ],
    },
    {
      id: 'save',
      kind: 'tool',
      label: 'Save to the library',
      tool: 'pattern.save',
      inputs: { pattern: 'normalized' },
      output: { file: 'savedFile', name: 'patternName' },
    },
    { id: 'saved', kind: 'end', label: 'Saved', outcome: 'success' },
    { id: 'invalid', kind: 'end', label: 'Could not validate', outcome: 'failed' },
    { id: 'notSaved', kind: 'end', label: 'Not saved', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-catalog', from: 'start', to: 'catalog' },
    { id: 'catalog-read', from: 'catalog', to: 'read' },
    { id: 'read-map', from: 'read', to: 'map' },
    { id: 'map-draft', from: 'map', to: 'draft' },
    { id: 'draft-validate', from: 'draft', to: 'validate' },
    { id: 'validate-valid', from: 'validate', to: 'valid' },
    { id: 'valid-approve', from: 'valid', to: 'approve', branch: 'then' },
    { id: 'valid-sendBack', from: 'valid', to: 'sendBack', branch: 'else' },
    { id: 'sendBack-left', from: 'sendBack', to: 'roundsLeft' },
    { id: 'left-draft', from: 'roundsLeft', to: 'draft', branch: 'then', label: 'fix the errors' },
    { id: 'left-invalid', from: 'roundsLeft', to: 'invalid', branch: 'else' },
    { id: 'approve-changes', from: 'approve', to: 'hasFeedback', branch: 'approved' },
    { id: 'approve-rejected', from: 'approve', to: 'notSaved', branch: 'rejected' },
    { id: 'changes-revisions', from: 'hasFeedback', to: 'revisionsLeft', branch: 'then' },
    { id: 'changes-save', from: 'hasFeedback', to: 'save', branch: 'else' },
    { id: 'revisions-revise', from: 'revisionsLeft', to: 'revise', branch: 'then' },
    { id: 'revisions-notSaved', from: 'revisionsLeft', to: 'notSaved', branch: 'else' },
    { id: 'revise-draft', from: 'revise', to: 'draft', label: 'apply feedback' },
    { id: 'save-saved', from: 'save', to: 'saved' },
  ],
  demo: {
    goal: 'A storm: chaos at the edges, stillness at the center; meaning lives in the in-between',
    context: {
      metaphor:
        'Chaos is a storm: wild at the edges, still at the center. Instead of filtering raindrops to fit our pattern, we sit in the clouds until we feel their beat. Signal and noise cannot be separated.',
      purpose: 'Read a noisy dataset without filtering it into a single answer',
    },
    agents: {
      read: () => ({
        updates: {
          frames: ['edge: volatility', 'center: stillness', 'in-between: shared rhythm'],
          tensions: [
            'filter vs immersion — keeping only what fits, or listening to everything',
            'prediction vs attunement — guessing the next strike, or feeling the beat',
          ],
          movements: [
            'enter the storm: take in every raindrop',
            'listen in rounds until a rhythm is felt',
            'hold edge, center and rhythm together',
          ],
          invariants: ['no single frame wins', 'the edge is never discarded'],
        },
        verdict: v('read'),
      }),
      map: () => ({
        updates: {
          mapping: [
            'Ground: the given data → tool gather — every file, unfiltered',
            'Voice: edge → assessor edge — where it is most volatile',
            'Voice: center → assessor center — what does not move',
            'Pulse + Tension: prediction vs attunement → condition felt, bounded by rounds — listen again until the rhythm is felt',
            'Coexistence → compute hold — edge, center and rhythm kept together',
            'Resolution → end inBetween; result lists edge, center and rhythm',
          ],
        },
        verdict: v('mapped'),
      }),
      draft: () => ({
        updates: {
          draft: {
            name: 'storm-listening',
            description: 'Read noisy data as a storm: edge, center and rhythm, held together.',
            verbTriggers: ['storm', 'listen to the data'],
            requiredContext: ['subject'],
            goalFrom: 'subject',
            result: ['edge', 'center', 'rhythm'],
            state: [
              { name: 'subject', type: 'string' },
              { name: 'edge', type: 'string[]' },
              { name: 'center', type: 'string[]' },
              { name: 'rhythm', type: 'string[]' },
              { name: 'felt', type: 'boolean' },
              { name: 'rounds', type: 'number' },
              { name: 'maxRounds', type: 'number', initial: 3 },
            ],
            start: 'start',
            nodes: [
              { id: 'start', kind: 'start', label: 'Enter the storm' },
              {
                id: 'edge',
                kind: 'agent',
                role: 'assessor',
                label: 'Edge',
                directive: 'Where is `subject` most volatile? Keep it all.',
                reads: ['subject'],
                writes: ['edge'],
              },
              {
                id: 'center',
                kind: 'agent',
                role: 'assessor',
                label: 'Center',
                directive: 'What in `subject` does not move?',
                reads: ['subject'],
                writes: ['center'],
              },
              {
                id: 'listen',
                kind: 'agent',
                role: 'assessor',
                label: 'Listen',
                directive:
                  'Listen between `edge` and `center`: what rhythm repeats? Set felt when you feel it.',
                reads: ['subject', 'edge', 'center', 'rhythm'],
                writes: ['rhythm', 'felt'],
                maxVisits: 4,
              },
              {
                id: 'round',
                kind: 'compute',
                label: 'One more round',
                assign: [{ field: 'rounds', expr: 'rounds + 1' }],
              },
              {
                id: 'feltIt',
                kind: 'condition',
                label: 'Felt?',
                expression: 'felt || rounds >= maxRounds',
              },
              { id: 'inBetween', kind: 'end', label: 'In the in-between', outcome: 'success' },
            ],
            edges: [
              { id: 'e1', from: 'start', to: 'edge' },
              { id: 'e2', from: 'edge', to: 'center' },
              { id: 'e3', from: 'center', to: 'listen' },
              { id: 'e4', from: 'listen', to: 'round' },
              { id: 'e5', from: 'round', to: 'feltIt' },
              { id: 'e6', from: 'feltIt', to: 'inBetween', branch: 'then' },
              { id: 'e7', from: 'feltIt', to: 'listen', branch: 'else' },
            ],
          },
        },
        verdict: v('drafted'),
      }),
    },
    tools: {
      catalog: () => ({
        names: [
          'investigate',
          'fix',
          'refactor',
          'implement',
          'backlog',
          'review',
          'analyze',
          'metaphor',
          'hangman',
        ],
        summaries: [
          'investigate: answer a question with cited evidence',
          'analyze: explore a dataset',
        ],
      }),
      validate: (s) => ({ errors: [], valid: true, pattern: s.draft }),
      save: (s) => ({
        file: `src/patterns/drafts/${String((s.normalized as { name?: string }).name)}.ts`,
        name: (s.normalized as { name?: string }).name,
      }),
    },
    approvals: { approve: () => ({ approved: true, updates: { feedback: '' } }) },
  },
};
