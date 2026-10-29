import { compileScore } from '../core/compile.js';
import { triggerMatches } from './route.js';
import {
  adaptPattern,
  draftInstructions,
  genericDraft,
  outlinePattern,
  parseDraft,
} from '../core/draft.js';
import type { ExecutableScore, Improvisation, Pattern } from '../core/types.js';
import { analyze } from './analyze.js';
import { fix } from './fix.js';

/**
 * Maestro: the meta-algorithm. It composes the score the orchestra will play.
 *
 *   route      deterministic verb match, then the AI confirms the pattern (or 'new')
 *              and classifies complexity 1-4
 *   debate     roster by complexity: 1 proposer (skipped when a pattern already fits),
 *              2 + skeptic, 3 + pragmatist, 4 + template-critic (may reroute once)
 *   revise     the conductor folds the debate into one draft
 *   validate   a tool checks the draft deterministically; errors loop back (max rounds)
 *   go-gate    a human approves, sends feedback (next round escalates complexity) or stops
 *
 * The approved score (state.finalPattern) is then performed as its own run,
 * at the final complexity: see `composedScore`.
 */

const SCORE_FORMAT = draftInstructions();
/** Offline library for the demo script (the real run lists the whole library with a tool). */
const DEMO_LIBRARY: readonly Pattern[] = [fix, analyze];

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

export const maestro: Pattern = {
  name: 'maestro',
  description:
    'Compose the right score for a request: route to a pattern, classify complexity, debate the algorithm (proposer, skeptic, pragmatist, template-critic by tier), validate it, and get your go.',
  verbTriggers: [],
  requiredContext: ['request'],
  goalFrom: 'request',
  // Feedback that came after the last round, kept rather than dropped (like unresolvedObjections).
  result: ['unappliedFeedback'],
  maxSteps: 400,
  state: [
    { name: 'request', type: 'string', description: "The user's problem, verbatim" },
    { name: 'names', type: 'string[]', description: 'Patterns in the library' },
    { name: 'summaries', type: 'string[]', description: 'One line per pattern' },
    { name: 'catalog', type: 'object', description: 'Pattern definitions by name' },
    { name: 'suggested', type: 'string', description: 'Verb-trigger route' },
    {
      name: 'pastCompositions',
      type: 'string[]',
      description: 'Approved compositions of similar earlier requests (precedent)',
    },
    {
      name: 'remembered',
      type: 'object',
      description: 'An approved composition of this same request, to reuse ({} if none)',
    },
    { name: 'reused', type: 'boolean', description: 'Composed from memory, without a debate' },
    { name: 'compositionSaved', type: 'boolean' },
    { name: 'chosen', type: 'string', description: "Pattern name, or 'new'" },
    {
      name: 'complexity',
      type: 'number',
      description: '1..4; picks the model tier and the debate roster',
    },
    { name: 'classifyReason', type: 'string' },
    {
      name: 'presetComplexity',
      type: 'number',
      description: 'The complexity you chose for the run (0 = let the maestro classify)',
    },
    { name: 'ratedComplexity', type: 'number', description: "The classifier's own rating" },
    {
      name: 'thenPattern',
      type: 'string',
      description: "Pattern to play after the composed score with its result, or ''",
    },
    {
      name: 'template',
      type: 'object',
      description: 'Definition of the chosen pattern ({} when new)',
    },
    {
      name: 'draft',
      type: 'object',
      description:
        'A full pattern: for new ones, or a library one whose shape must change ({} otherwise)',
    },
    {
      name: 'adaptation',
      type: 'object',
      description:
        'How the library pattern is tailored without rewriting it: { directives: { step: guidance }, initial: { setting: value } }',
    },
    { name: 'outline', type: 'string[]', description: "The chosen pattern's steps, compactly" },
    { name: 'settings', type: 'string[]', description: "The chosen pattern's tunable settings" },
    { name: 'assumptions', type: 'string[]' },
    { name: 'failureModes', type: 'string[]', description: 'Skeptic: concrete failure scenarios' },
    { name: 'contested', type: 'string[]', description: 'Skeptic: assumptions likely false here' },
    { name: 'edits', type: 'string[]', description: 'Skeptic: concrete suggested edits' },
    { name: 'triage', type: 'string[]', description: 'Pragmatist: one entry per failure mode' },
    { name: 'cuts', type: 'string[]', description: 'Pragmatist: steps that could be cut' },
    { name: 'leaner', type: 'object', description: 'Pragmatist: leaner candidate ({} if none)' },
    {
      name: 'fit',
      type: 'string',
      description: 'Template-critic verdict: CORRECT | WRONG | HYBRID',
    },
    { name: 'criticReason', type: 'string' },
    {
      name: 'recommended',
      type: 'string',
      description: "Template-critic: better pattern, 'new', or ''",
    },
    { name: 'rerouted', type: 'boolean' },
    {
      name: 'debateNotes',
      type: 'string[]',
      description:
        'Notes on how the score was reached: approach, what was debated, open doubts, removed steps',
    },
    { name: 'draftErrors', type: 'string[]' },
    { name: 'draftValid', type: 'boolean' },
    { name: 'normalized', type: 'object', description: 'The validated score' },
    { name: 'needs', type: 'string[]', description: 'Inputs the score needs: "name (type): what"' },
    { name: 'round', type: 'number', initial: 1 },
    { name: 'maxRounds', type: 'number', initial: 6 },
    {
      name: 'childContext',
      type: 'object',
      description: 'Inputs for the score, read from the request',
    },
    { name: 'contextNotes', type: 'string[]' },
    {
      name: 'feedback',
      type: 'string',
      description: 'Your changes for another round (empty = go)',
    },
    { name: 'finalPattern', type: 'object', description: 'The approved score' },
    {
      name: 'unappliedFeedback',
      type: 'string',
      description:
        'Go-gate feedback that came after the last round: not applied, the score not performed',
    },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'notePreset',
      kind: 'compute',
      label: 'Note preset tier',
      // A complexity chosen for the run starts in `complexity` (compile); 0 = auto.
      assign: [{ field: 'presetComplexity', expr: 'complexity' }],
    },
    {
      id: 'library',
      kind: 'tool',
      label: 'Read the library',
      tool: 'patterns.list',
      output: { names: 'names', summaries: 'summaries', catalog: 'catalog' },
    },
    {
      id: 'route',
      kind: 'tool',
      label: 'Match verbs',
      tool: 'patterns.route',
      inputs: { request: 'request' },
      output: { suggested: 'suggested' },
    },
    {
      id: 'recall',
      kind: 'tool',
      label: 'Recall compositions',
      tool: 'compositions.recall',
      inputs: { request: 'request' },
      output: { exact: 'remembered', similar: 'pastCompositions' },
    },
    {
      id: 'hasRemembered',
      kind: 'condition',
      label: 'Composed before?',
      expression: 'len(keys(remembered)) > 0',
    },
    {
      id: 'reuse',
      kind: 'compute',
      label: 'Reuse composition',
      // The same request, approved before on the same pattern: no classification, no debate.
      assign: [
        { field: 'chosen', expr: 'get(remembered, "chosen")' },
        {
          field: 'complexity',
          expr: 'if(presetComplexity > 0, presetComplexity, get(remembered, "complexity"))',
        },
        { field: 'thenPattern', expr: 'get(remembered, "thenPattern")' },
        {
          field: 'template',
          expr: 'if(get(remembered, "chosen") == "new", {}, get(catalog, get(remembered, "chosen")))',
        },
        { field: 'adaptation', expr: 'get(remembered, "adaptation")' },
        { field: 'draft', expr: 'get(remembered, "pattern")' },
        { field: 'reused', expr: 'true' },
        {
          field: 'debateNotes',
          expr: '["Reused: this request was composed and approved before, so there was no debate. Write feedback to compose it afresh."]',
        },
      ],
    },
    {
      id: 'classify',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      complexity: 2,
      label: 'Route and classify',
      directive:
        "Decide which pattern from `summaries` fits `request`, or 'new' if none has the right shape. `suggested` is the verb-trigger match: keep it unless the request clearly signals another shape (e.g. 'fix' but architectural -> not fix; 'investigate' but the cause is already known -> fix). Then classify complexity, picking the LOWEST tier that covers the risk: 1 routine and well understood; 2 some judgement or several steps; 3 cross-cutting, risky or ambiguous; 4 novel, where the pattern fit itself is in question. Explain both choices in one or two sentences in `classifyReason`. If the request asks for two shapes in sequence (e.g. 'find out why X, then fix it' -> chosen investigate, then fix; 'understand this module and clean it up' -> investigate, then refactor), set `thenPattern` to the second pattern from `names`: it plays after the first with what the first found. Otherwise set `thenPattern` to ''. Do not chain when one pattern already covers both (fix diagnoses before it edits). `pastCompositions` are approved compositions of similar earlier requests in this workspace: follow their choice of pattern, complexity and thenPattern when this request is the same kind, unless it signals otherwise.",
      reads: ['request', 'summaries', 'suggested', 'pastCompositions'],
      writes: ['chosen', 'complexity', 'classifyReason', 'thenPattern'],
      retries: 2,
      checks: [
        {
          expr: 'includes(names + ["new"], chosen)',
          message: "chosen must be a name from the library or 'new'.",
        },
        { expr: 'includes([1, 2, 3, 4], complexity)', message: 'complexity must be 1, 2, 3 or 4.' },
        {
          expr: 'empty(thenPattern) || (includes(names, thenPattern) && thenPattern != chosen && thenPattern != "maestro")',
          message:
            "thenPattern must be '' or another pattern name from names (not chosen, not maestro).",
        },
      ],
    },
    {
      id: 'keepPreset',
      kind: 'compute',
      label: 'Preset tier wins',
      // You set the cost tier: the classifier's rating is kept for the record, not used.
      assign: [
        { field: 'ratedComplexity', expr: 'complexity' },
        { field: 'complexity', expr: 'if(presetComplexity > 0, presetComplexity, complexity)' },
      ],
    },
    {
      id: 'load',
      kind: 'compute',
      label: 'Load template',
      assign: [
        { field: 'template', expr: 'if(chosen == "new", {}, get(catalog, chosen))' },
        { field: 'draft', expr: '{}' },
        { field: 'adaptation', expr: '{}' },
      ],
    },
    {
      id: 'outline',
      kind: 'tool',
      label: 'Outline template',
      // The debate reads this, not the template: a fraction of the tokens.
      tool: 'pattern.outline',
      inputs: { pattern: 'template' },
      output: { steps: 'outline', settings: 'settings' },
    },
    {
      id: 'debate',
      kind: 'condition',
      label: 'Debate needed?',
      expression: '(complexity > 1 || chosen == "new") && !reused',
    },
    {
      id: 'propose',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Proposer',
      directive: `You are the PROPOSER: compose the score (an executable workflow pattern) for \`request\`. Every debate responds to your proposal.
- If \`chosen\` is a library pattern (its steps are in \`outline\`, its settings in \`settings\`), it is tested: do NOT rewrite it. Tailor it in \`adaptation\` = { "directives": { "<agent step id>": "guidance for this request" }, "initial": { "<setting>": value } }: guidance is appended to that step's directive (what to look at first, which files, PRs, tests or errors the request names, what to ignore); initial values change settings (loop bounds, batch sizes, flags such as exhaustive). Only steps that need something specific; {} is fine. Leave \`draft\` as {}. Only if the request truly needs a different shape (steps added, removed or reordered) write the whole pattern in \`draft\` instead, and say why in \`assumptions\`.
- If \`chosen\` is 'new', draft a fresh pattern in \`draft\` and leave \`adaptation\` as {}.
- \`pastCompositions\` are approved compositions of similar earlier requests: when one used the same pattern, start from its adaptation and change only what this request needs.
- Revise rather than restart when \`adaptation\` or \`draft\` already holds a previous round: address \`draftErrors\`, \`feedback\`, and REAL concerns in \`failureModes\`/\`triage\`, and follow the template-critic's \`fit\`/\`criticReason\`.
- Start with grounding (observe, reproduce, define) and end with verification (test, confirm). Prefer compute/condition/tool nodes for anything mechanical: AI only where judgement is needed. Bound every loop.
- Do not investigate the codebase: you plan, you do not diagnose.
- State 2-4 \`assumptions\`: what you assumed about this problem when choosing the steps. The skeptic attacks them.

Pattern format (for \`draft\`):
${SCORE_FORMAT}`,
      reads: [
        'request',
        'chosen',
        'outline',
        'settings',
        'adaptation',
        'draft',
        'pastCompositions',
        'complexity',
        'draftErrors',
        'feedback',
        'failureModes',
        'triage',
        'fit',
        'criticReason',
      ],
      writes: ['draft', 'adaptation', 'assumptions'],
      retries: 2,
      checks: [
        {
          expr: 'chosen != "new" || len(keys(draft)) > 0',
          message: 'chosen is new: put the full pattern object in draft.',
        },
        { expr: 'len(assumptions) > 0', message: 'State your assumptions.' },
      ],
    },
    { id: 'hasSkeptic', kind: 'condition', label: 'Skeptic? (≥2)', expression: 'complexity >= 2' },
    {
      id: 'skeptic',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Skeptic',
      directive:
        "You are the SKEPTIC: hunt for CONCRETE failure modes of the score applied to `request`: `draft` when it is not empty, otherwise the library pattern in `outline` tailored by `adaptation`. You are not a contrarian. Each `failureModes` entry must name a specific scenario where this score produces a wrong result (bad: 'step 3 might miss cases'; good: 'diagnose assumes the bug is deterministic; on a race it passes verification without fixing it'). `contested`: which of `assumptions` are most likely false for this request. `edits`: concrete Add/Remove/Reword/Reorder edits, one reason each. Empty lists are fine and better than invented concerns. No style comments, no full alternative algorithm. If the shape is wrong, say 'template mismatch' in one entry.",
      reads: ['request', 'draft', 'outline', 'adaptation', 'assumptions', 'complexity'],
      writes: ['failureModes', 'contested', 'edits'],
      retries: 2,
    },
    {
      id: 'concerns',
      kind: 'condition',
      label: 'Anything to change?',
      // Nothing to fold in: the proposal stands, skip the pragmatist and the conductor.
      // At tier 4 the template-critic still judges the fit.
      expression: 'len(failureModes) + len(edits) > 0 || complexity >= 4',
    },
    {
      id: 'hasPragmatist',
      kind: 'condition',
      label: 'Pragmatist? (≥3)',
      expression: 'complexity >= 3',
    },
    {
      id: 'pragmatist',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Pragmatist',
      directive:
        "You are the PRAGMATIST: enforce the minimum viable score. For EVERY entry of `failureModes` write one `triage` entry, in the same order: '<concern, abbreviated>: REAL | THEORETICAL | WRONG TEMPLATE — <one-sentence reason>'. REAL means the score must change; THEORETICAL means addressing it costs more than ignoring it; WRONG TEMPLATE means the problem does not fit the pattern's shape. `cuts`: steps that add cost without reducing risk here (empty if every step earns its keep; user attention is a cost); for a library pattern (`outline`), cut by lowering its loop bounds in `adaptation.initial`, not by removing steps. `leaner`: a full leaner pattern ONLY if `draft` is a full pattern and it meaningfully tightens it, else {}. You never add steps.",
      reads: [
        'request',
        'draft',
        'outline',
        'adaptation',
        'assumptions',
        'failureModes',
        'contested',
        'edits',
      ],
      writes: ['triage', 'cuts', 'leaner'],
      retries: 2,
      checks: [
        {
          expr: 'len(triage) == len(failureModes)',
          message:
            'Triage EVERY skeptic failure mode: exactly one triage entry per failureModes entry.',
        },
      ],
    },
    {
      id: 'hasCritic',
      kind: 'condition',
      label: 'Template-critic? (4)',
      expression: 'complexity >= 4',
    },
    {
      id: 'critic',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Template-critic',
      directive:
        "You are the TEMPLATE-CRITIC: the dissent on pattern fit. Is `chosen` the right shape for `request`, given `summaries`? Default to CORRECT; overturn only with a specific quote or signal from the request ('fix' but mentions several systems -> refactor/feature; 'investigate' but the cause is known -> fix; 'while we are at it' -> hybrid). `fit` (your verdict): exactly CORRECT, WRONG or HYBRID. `criticReason`: 1-3 sentences specific to this request. `recommended`: if WRONG, a pattern name from `names` or 'new' (never invent a name); if HYBRID, the pattern that should drive; if CORRECT, ''.",
      reads: [
        'request',
        'chosen',
        'summaries',
        'names',
        'draft',
        'outline',
        'adaptation',
        'failureModes',
        'triage',
      ],
      writes: ['fit', 'criticReason', 'recommended'],
      retries: 2,
      checks: [
        {
          expr: 'includes(["CORRECT", "WRONG", "HYBRID"], fit)',
          message: 'fit must be CORRECT, WRONG or HYBRID.',
        },
        {
          expr: 'fit == "CORRECT" || !empty(recommended)',
          message: 'WRONG or HYBRID needs a recommended pattern.',
        },
        {
          expr: 'empty(recommended) || includes(names + ["new"], recommended)',
          message: "recommended must be a library pattern name or 'new'.",
        },
      ],
    },
    {
      id: 'reroute',
      kind: 'condition',
      label: 'Reroute?',
      expression: 'fit == "WRONG" && !rerouted && recommended != chosen',
    },
    {
      id: 'switch',
      kind: 'compute',
      label: 'Switch pattern',
      assign: [
        { field: 'chosen', expr: 'recommended' },
        { field: 'template', expr: 'if(recommended == "new", {}, get(catalog, recommended))' },
        { field: 'draft', expr: '{}' },
        { field: 'adaptation', expr: '{}' },
        { field: 'rerouted', expr: 'true' },
        { field: 'fit', expr: '""' },
      ],
    },
    {
      id: 'revise',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Conductor',
      // Keep the notes' wording neutral: first-person, emotional phrasing ("how I got
      // here", "unsure, cut") made a provider content filter block every answer here.
      directive: `You are the CONDUCTOR: fold the debate into ONE final score. For a library pattern (\`outline\`), the final score is \`adaptation\` (guidance per agent step, settings in initial; keep \`draft\` as {} unless the proposer rewrote it for a reason the debate upheld); for 'new' it is \`draft\`. Start from what the proposer wrote. Apply every concern the pragmatist marked REAL (if no pragmatist ran, every concrete skeptic concern), the skeptic's sound \`edits\`, and the pragmatist's \`cuts\`/\`leaner\` where they do not drop a load-bearing step. Ignore THEORETICAL concerns. Do not add steps nobody argued for. Put the final score in \`adaptation\` or \`draft\` and summarize in \`debateNotes\` (short entries, omit empty ones): 'Approach: ...', 'Debated: ...', 'Open doubts: ...', 'Removed steps: ...'. Refer to agents by what they did.

Pattern format (for \`draft\`):
${SCORE_FORMAT}`,
      reads: [
        'request',
        'chosen',
        'draft',
        'outline',
        'settings',
        'adaptation',
        'assumptions',
        'failureModes',
        'contested',
        'edits',
        'triage',
        'cuts',
        'leaner',
        'fit',
        'criticReason',
      ],
      writes: ['draft', 'adaptation', 'debateNotes'],
      retries: 2,
      checks: [
        {
          expr: 'chosen != "new" || len(keys(draft)) > 0',
          message: 'chosen is new: put the final pattern object in draft.',
        },
      ],
    },
    {
      id: 'validate',
      kind: 'tool',
      label: 'Validate score',
      tool: 'pattern.validate',
      // An empty draft means the library template as adapted: its shape stays as tested.
      inputs: { pattern: 'draft', template: 'template', adaptation: 'adaptation' },
      output: {
        errors: 'draftErrors',
        valid: 'draftValid',
        pattern: 'normalized',
        inputs: 'needs',
      },
    },
    { id: 'valid', kind: 'condition', label: 'Valid?', expression: 'draftValid' },
    { id: 'roundsLeft', kind: 'condition', label: 'Rounds left?', expression: 'round < maxRounds' },
    {
      id: 'retry',
      kind: 'compute',
      label: 'Next round (fix errors)',
      assign: [{ field: 'round', expr: 'round + 1' }],
    },
    {
      id: 'context',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      complexity: 1,
      label: 'Read inputs',
      directive:
        'Fill `childContext` with a value for EVERY input in `needs` ("name (type): what"), keyed by name and of that type, read from `request` (the user\'s words; never invent facts). If the request does not contain a value, use an empty string (or empty list) and say which input is missing in `contextNotes`.',
      reads: ['request', 'needs'],
      writes: ['childContext', 'contextNotes'],
      retries: 2,
      checks: [
        {
          expr: 'subset(get(normalized, "requiredContext"), keys(childContext))',
          message: 'childContext needs every key in normalized.requiredContext.',
        },
      ],
    },
    {
      id: 'gate',
      kind: 'approval',
      label: 'Go-gate',
      message:
        'The maestro composed this score. Approve with empty feedback to perform it. Write feedback to send it back for another round (complexity escalates one tier). Reject to stop.',
      writes: ['feedback'],
      maxVisits: 6,
    },
    {
      id: 'escalate',
      kind: 'compute',
      label: 'Escalate',
      assign: [
        { field: 'round', expr: 'round + 1' },
        { field: 'complexity', expr: 'if(complexity < 4, complexity + 1, 4)' },
        // Feedback on a reused composition composes it afresh.
        { field: 'reused', expr: 'false' },
      ],
    },
    {
      id: 'finalize',
      kind: 'compute',
      label: 'Final score',
      assign: [{ field: 'finalPattern', expr: 'normalized' }],
    },
    {
      id: 'remember',
      kind: 'tool',
      label: 'Remember composition',
      tool: 'compositions.remember',
      inputs: {
        request: 'request',
        chosen: 'chosen',
        complexity: 'complexity',
        thenPattern: 'thenPattern',
        adaptation: 'adaptation',
        draft: 'draft',
        pattern: 'normalized',
      },
      output: { saved: 'compositionSaved' },
    },
    { id: 'done', kind: 'end', label: 'Score composed', outcome: 'success' },
    { id: 'gaveUp', kind: 'end', label: 'No valid score', outcome: 'failed' },
    { id: 'stopped', kind: 'end', label: 'Stopped', outcome: 'partial' },
    {
      id: 'outOfRounds',
      kind: 'compute',
      label: 'Out of rounds',
      // Never perform a score over a change you asked for: keep the draft and your feedback.
      assign: [
        { field: 'unappliedFeedback', expr: 'feedback' },
        {
          field: 'debateNotes',
          expr: 'append(debateNotes, "Not applied, out of rounds (maxRounds): " + feedback)',
        },
      ],
    },
    {
      id: 'feedbackUnapplied',
      kind: 'end',
      label: 'Out of rounds: feedback not applied',
      outcome: 'partial',
    },
  ],
  edges: [
    { id: 'start-notePreset', from: 'start', to: 'notePreset' },
    { id: 'notePreset-library', from: 'notePreset', to: 'library' },
    { id: 'library-route', from: 'library', to: 'route' },
    { id: 'route-recall', from: 'route', to: 'recall' },
    { id: 'recall-hasRemembered', from: 'recall', to: 'hasRemembered' },
    { id: 'hasRemembered-reuse', from: 'hasRemembered', to: 'reuse', branch: 'then' },
    { id: 'hasRemembered-classify', from: 'hasRemembered', to: 'classify', branch: 'else' },
    { id: 'reuse-outline', from: 'reuse', to: 'outline', label: 'composed before' },
    { id: 'classify-keepPreset', from: 'classify', to: 'keepPreset' },
    { id: 'keepPreset-load', from: 'keepPreset', to: 'load' },
    { id: 'load-outline', from: 'load', to: 'outline' },
    { id: 'outline-debate', from: 'outline', to: 'debate' },
    { id: 'debate-propose', from: 'debate', to: 'propose', branch: 'then' },
    {
      id: 'debate-validate',
      from: 'debate',
      to: 'validate',
      branch: 'else',
      label: 'pattern fits as is',
    },
    { id: 'propose-hasSkeptic', from: 'propose', to: 'hasSkeptic' },
    { id: 'hasSkeptic-skeptic', from: 'hasSkeptic', to: 'skeptic', branch: 'then' },
    { id: 'hasSkeptic-validate', from: 'hasSkeptic', to: 'validate', branch: 'else' },
    { id: 'skeptic-concerns', from: 'skeptic', to: 'concerns' },
    { id: 'concerns-hasPragmatist', from: 'concerns', to: 'hasPragmatist', branch: 'then' },
    {
      id: 'concerns-validate',
      from: 'concerns',
      to: 'validate',
      branch: 'else',
      label: 'the proposal stands',
    },
    { id: 'hasPragmatist-pragmatist', from: 'hasPragmatist', to: 'pragmatist', branch: 'then' },
    { id: 'hasPragmatist-revise', from: 'hasPragmatist', to: 'revise', branch: 'else' },
    { id: 'pragmatist-hasCritic', from: 'pragmatist', to: 'hasCritic' },
    { id: 'hasCritic-critic', from: 'hasCritic', to: 'critic', branch: 'then' },
    { id: 'hasCritic-revise', from: 'hasCritic', to: 'revise', branch: 'else' },
    { id: 'critic-reroute', from: 'critic', to: 'reroute' },
    { id: 'reroute-switch', from: 'reroute', to: 'switch', branch: 'then' },
    { id: 'reroute-revise', from: 'reroute', to: 'revise', branch: 'else' },
    { id: 'switch-outline', from: 'switch', to: 'outline', label: 'rerouted' },
    { id: 'revise-validate', from: 'revise', to: 'validate' },
    { id: 'validate-valid', from: 'validate', to: 'valid' },
    { id: 'valid-context', from: 'valid', to: 'context', branch: 'then' },
    { id: 'valid-roundsLeft', from: 'valid', to: 'roundsLeft', branch: 'else' },
    { id: 'roundsLeft-retry', from: 'roundsLeft', to: 'retry', branch: 'then' },
    { id: 'roundsLeft-gaveUp', from: 'roundsLeft', to: 'gaveUp', branch: 'else' },
    { id: 'retry-propose', from: 'retry', to: 'propose', label: 'fix errors' },
    { id: 'context-gate', from: 'context', to: 'gate' },
    {
      id: 'gate-escalate',
      from: 'gate',
      to: 'escalate',
      branch: 'approved',
      guard: '!empty(feedback) && round < maxRounds',
      label: 'feedback',
    },
    {
      id: 'gate-outOfRounds',
      from: 'gate',
      to: 'outOfRounds',
      branch: 'approved',
      guard: '!empty(feedback)',
      label: 'feedback, no rounds left',
    },
    { id: 'gate-finalize', from: 'gate', to: 'finalize', branch: 'approved' },
    { id: 'outOfRounds-end', from: 'outOfRounds', to: 'feedbackUnapplied' },
    { id: 'gate-stopped', from: 'gate', to: 'stopped', branch: 'rejected' },
    { id: 'escalate-propose', from: 'escalate', to: 'propose', label: 'next round' },
    { id: 'finalize-remember', from: 'finalize', to: 'remember' },
    { id: 'remember-done', from: 'remember', to: 'done' },
  ],
  demo: {
    context: { request: 'Fix the flaky login test that fails on CI about once in ten runs' },
    tools: {
      library: () => ({
        names: DEMO_LIBRARY.map((p) => p.name),
        summaries: DEMO_LIBRARY.map((p) => `${p.name}: ${p.description}`),
        catalog: Object.fromEntries(DEMO_LIBRARY.map(({ demo: _d, ...p }) => [p.name, p])),
      }),
      recall: () => ({ exact: {}, similar: [] }),
      remember: () => ({ saved: true }),
      route: (s) => {
        const text = String(s.request).toLowerCase();
        const hit = DEMO_LIBRARY.find((p) =>
          (p.verbTriggers ?? []).some((t) => triggerMatches(text, t)),
        );
        return { suggested: hit?.name ?? 'new' };
      },
      outline: (s) => {
        const t = parseDraft(s.template);
        return t.ok ? outlinePattern(t.value) : { steps: [], settings: [] };
      },
      validate: (s) => {
        const filled = Object.keys((s.draft as object | undefined) ?? {}).length > 0;
        const t = filled ? undefined : parseDraft(s.template);
        const adapted = t?.ok ? adaptPattern(t.value, s.adaptation) : undefined;
        if (adapted?.errors.length)
          return { errors: adapted.errors, valid: false, pattern: {}, inputs: [] };
        const parsed = parseDraft(adapted ? adapted.pattern : s.draft);
        return parsed.ok
          ? {
              errors: [],
              valid: true,
              pattern: (({ demo: _d, ...p }) => p)(parsed.value),
              inputs: parsed.value.requiredContext.map((k) => `${k} (string)`),
            }
          : { errors: parsed.errors, valid: false, pattern: {}, inputs: [] };
      },
    },
    agents: {
      classify: (s) => ({
        updates: {
          chosen: String(s.suggested),
          complexity: s.suggested === 'new' ? 2 : 3,
          classifyReason: `Verb match '${String(s.suggested)}'; flaky behaviour makes it riskier than routine.`,
          thenPattern: '',
        },
        verdict: v('routed'),
      }),
      propose: (s) => {
        return {
          updates: {
            draft: s.chosen === 'new' ? genericDraft(String(s.request)) : {},
            // The demo's guidance is written for fix's steps; other patterns play as they are.
            adaptation:
              s.chosen === 'fix'
                ? {
                    directives: {
                      hypothesize:
                        'It fails about once in ten CI runs: include timing races and state shared between tests.',
                    },
                    initial: { maxAttempts: 2 },
                  }
                : {},
            assumptions: [
              'The failure can be reproduced by running the test repeatedly',
              'The fix is local to the test or its fixture',
            ],
          },
          verdict: v('drafted'),
        };
      },
      skeptic: () => ({
        updates: {
          failureModes: [
            'Diagnose assumes a deterministic bug; a timing race would pass verify once and still flake',
          ],
          contested: ['Reproducible by repetition: CI-only timing may not reproduce locally'],
          edits: ['Reword verify: run the test 20 times, not once'],
        },
        verdict: v('one concrete failure mode'),
      }),
      pragmatist: (s) => ({
        updates: {
          triage: ((s.failureModes as string[]) ?? []).map(
            (f) => `${f.slice(0, 40)}: REAL — flakiness is the problem`,
          ),
          cuts: [],
          leaner: {},
        },
        verdict: v('triaged'),
      }),
      critic: () => ({
        updates: {
          fit: 'CORRECT',
          criticReason: 'A failing test with a known symptom is a fix.',
          recommended: '',
        },
        verdict: v('fit confirmed'),
      }),
      revise: (s) => ({
        updates: {
          draft: s.draft as Record<string, unknown>,
          adaptation: s.adaptation as Record<string, unknown>,
          debateNotes: [
            'Approach: started from the fix pattern.',
            'Debated: whether one passing run proves a flaky fix (it does not).',
            'Open doubts: whether CI timing reproduces locally.',
          ],
        },
        verdict: v('conducted'),
      }),
      context: (s) => {
        const required = ((s.normalized as Pattern | undefined)?.requiredContext ?? []) as string[];
        return {
          updates: {
            childContext: Object.fromEntries(required.map((k) => [k, String(s.request)])),
            contextNotes: [],
          },
          verdict: v('inputs read'),
        };
      },
    },
    approvals: { gate: () => ({ approved: true, updates: { feedback: '' } }) },
  },
};

/** Inputs typed by the composed pattern's state fields (drops unknown or empty values). */
function typedContext(pattern: Pattern, raw: unknown): Record<string, unknown> {
  const fields = new Set(pattern.state.map((f) => f.name));
  const entries =
    raw && typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>) : [];
  return Object.fromEntries(
    entries.filter(
      ([k, x]) => fields.has(k) && x !== '' && x !== null && !(Array.isArray(x) && x.length === 0),
    ),
  );
}

/**
 * The score the maestro composed, ready to perform: compiled with the request as goal,
 * the extracted inputs, the final complexity and the maestro run's improvisation level.
 */
/** Patterns the maestro chose to play after its composed score (at most one). */
export function maestroThen(finalState: Readonly<Record<string, unknown>>): string[] {
  const then = finalState.thenPattern;
  return typeof then === 'string' && then.trim() ? [then.trim()] : [];
}

export function composedScore(
  maestroScore: ExecutableScore,
  finalState: Readonly<Record<string, unknown>>,
  opts: { readonly generatedAt?: string; readonly improvisation?: Improvisation } = {},
): { readonly pattern: Pattern; readonly score: ExecutableScore } | undefined {
  if (maestroScore.pattern !== 'maestro') return undefined;
  const parsed = parseDraft(finalState.finalPattern);
  if (!parsed.ok) return undefined;
  const c = finalState.complexity;
  const complexity = c === 1 || c === 2 || c === 3 || c === 4 ? c : maestroScore.complexity;
  const pattern = parsed.value;
  const score = compileScore(pattern, {
    goal: String(finalState.request ?? maestroScore.goal),
    context: typedContext(pattern, finalState.childContext),
    complexity,
    improvisation: opts.improvisation ?? maestroScore.improvisation,
    ...(opts.generatedAt ? { generatedAt: opts.generatedAt } : {}),
  });
  return { pattern, score };
}
