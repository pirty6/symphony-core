import { compileScore } from '../core/compile.js';
import { triggerMatches } from './route.js';
import { draftInstructions, genericDraft, parseDraft } from '../core/draft.js';
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
  maxSteps: 400,
  state: [
    { name: 'request', type: 'string', description: "The user's problem, verbatim" },
    { name: 'names', type: 'string[]', description: 'Patterns in the library' },
    { name: 'summaries', type: 'string[]', description: 'One line per pattern' },
    { name: 'catalog', type: 'object', description: 'Pattern definitions by name' },
    { name: 'suggested', type: 'string', description: 'Verb-trigger route' },
    { name: 'chosen', type: 'string', description: "Pattern name, or 'new'" },
    {
      name: 'complexity',
      type: 'number',
      description: '1..4; picks the model tier and the debate roster',
    },
    { name: 'classifyReason', type: 'string' },
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
    { name: 'draft', type: 'object', description: 'The proposed score (pattern JSON)' },
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
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
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
      id: 'classify',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      complexity: 2,
      label: 'Route and classify',
      directive:
        "Decide which pattern from `summaries` fits `request`, or 'new' if none has the right shape. `suggested` is the verb-trigger match: keep it unless the request clearly signals another shape (e.g. 'fix' but architectural -> not fix; 'investigate' but the cause is already known -> fix). Then classify complexity, picking the LOWEST tier that covers the risk: 1 routine and well understood; 2 some judgement or several steps; 3 cross-cutting, risky or ambiguous; 4 novel, where the pattern fit itself is in question. Explain both choices in one or two sentences in `classifyReason`. If the request asks for two shapes in sequence (e.g. 'find out why X, then fix it' -> chosen investigate, then fix; 'understand this module and clean it up' -> investigate, then refactor), set `thenPattern` to the second pattern from `names`: it plays after the first with what the first found. Otherwise set `thenPattern` to ''. Do not chain when one pattern already covers both (fix diagnoses before it edits).",
      reads: ['request', 'summaries', 'suggested'],
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
      id: 'load',
      kind: 'compute',
      label: 'Load template',
      assign: [
        { field: 'template', expr: 'if(chosen == "new", {}, get(catalog, chosen))' },
        { field: 'draft', expr: 'template' },
      ],
    },
    {
      id: 'debate',
      kind: 'condition',
      label: 'Debate needed?',
      expression: 'complexity > 1 || chosen == "new"',
    },
    {
      id: 'propose',
      kind: 'agent',
      role: 'assessor',
      isolated: true,
      label: 'Proposer',
      directive: `You are the PROPOSER: draft the score (an executable workflow pattern) for \`request\`. Every debate responds to your draft.
- If \`template\` is not empty, adapt it to this problem: keep its shape and name unless the problem needs a different one, sharpen directives for this request, add or remove steps only for a reason you state. If \`chosen\` is 'new', draft a fresh pattern from scratch.
- Revise rather than restart when \`draft\` already holds a previous round: address \`draftErrors\`, \`feedback\`, and REAL concerns in \`failureModes\`/\`triage\`, and follow the template-critic's \`fit\`/\`criticReason\`.
- Start with grounding (observe, reproduce, define) and end with verification (test, confirm). Prefer compute/condition/tool nodes for anything mechanical: AI only where judgement is needed. Bound every loop.
- Do not investigate the codebase: you plan, you do not diagnose.
- State 2-4 \`assumptions\`: what you assumed about this problem when choosing the steps. The skeptic attacks them.

${SCORE_FORMAT}

Put the whole pattern object in \`draft\`.`,
      reads: [
        'request',
        'chosen',
        'template',
        'draft',
        'complexity',
        'draftErrors',
        'feedback',
        'failureModes',
        'triage',
        'fit',
        'criticReason',
      ],
      writes: ['draft', 'assumptions'],
      retries: 2,
      checks: [
        { expr: 'len(keys(draft)) > 0', message: 'Put the full pattern object in draft.' },
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
        "You are the SKEPTIC: hunt for CONCRETE failure modes of `draft` applied to `request`. You are not a contrarian. Each `failureModes` entry must name a specific scenario where this score produces a wrong result (bad: 'step 3 might miss cases'; good: 'diagnose assumes the bug is deterministic; on a race it passes verification without fixing it'). `contested`: which of `assumptions` are most likely false for this request. `edits`: concrete Add/Remove/Reword/Reorder edits, one reason each. Empty lists are fine and better than invented concerns. No style comments, no full alternative algorithm. If the shape is wrong, say 'template mismatch' in one entry.",
      reads: ['request', 'draft', 'assumptions', 'complexity'],
      writes: ['failureModes', 'contested', 'edits'],
      retries: 2,
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
        "You are the PRAGMATIST: enforce the minimum viable score. For EVERY entry of `failureModes` write one `triage` entry, in the same order: '<concern, abbreviated>: REAL | THEORETICAL | WRONG TEMPLATE — <one-sentence reason>'. REAL means the score must change; THEORETICAL means addressing it costs more than ignoring it; WRONG TEMPLATE means the problem does not fit the pattern's shape. `cuts`: steps that add cost without reducing risk here (empty if every step earns its keep; user attention is a cost). `leaner`: a full leaner pattern ONLY if it meaningfully tightens the draft, else {}. You never add steps.",
      reads: ['request', 'draft', 'assumptions', 'failureModes', 'contested', 'edits'],
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
      reads: ['request', 'chosen', 'summaries', 'names', 'draft', 'failureModes', 'triage'],
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
        { field: 'draft', expr: 'template' },
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
      directive: `You are the CONDUCTOR: fold the debate into ONE final score. Start from \`draft\`. Apply every concern the pragmatist marked REAL (if no pragmatist ran, every concrete skeptic concern), the skeptic's sound \`edits\`, and the pragmatist's \`cuts\`/\`leaner\` where they do not drop a load-bearing step. Ignore THEORETICAL concerns. Do not add steps nobody argued for. Put the final pattern in \`draft\` and summarize in \`debateNotes\` (short entries, omit empty ones): 'Approach: ...', 'Debated: ...', 'Open doubts: ...', 'Removed steps: ...'. Refer to agents by what they did.

${SCORE_FORMAT}`,
      reads: [
        'request',
        'draft',
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
      writes: ['draft', 'debateNotes'],
      retries: 2,
      checks: [{ expr: 'len(keys(draft)) > 0', message: 'Put the final pattern object in draft.' }],
    },
    {
      id: 'validate',
      kind: 'tool',
      label: 'Validate score',
      tool: 'pattern.validate',
      inputs: { pattern: 'draft' },
      output: { errors: 'draftErrors', valid: 'draftValid', pattern: 'normalized' },
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
        "Fill `childContext` with a value for EVERY key in `normalized.requiredContext`, read from `request` (the user's words; never invent facts). Use the field types from `normalized.state`. If the request does not contain a value, use an empty string (or empty list) and say which key is missing in `contextNotes`.",
      reads: ['request', 'normalized'],
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
        { field: 'draft', expr: 'normalized' },
      ],
    },
    {
      id: 'finalize',
      kind: 'compute',
      label: 'Final score',
      assign: [{ field: 'finalPattern', expr: 'normalized' }],
    },
    { id: 'done', kind: 'end', label: 'Score composed', outcome: 'success' },
    { id: 'gaveUp', kind: 'end', label: 'No valid score', outcome: 'failed' },
    { id: 'stopped', kind: 'end', label: 'Stopped', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-library', from: 'start', to: 'library' },
    { id: 'library-route', from: 'library', to: 'route' },
    { id: 'route-classify', from: 'route', to: 'classify' },
    { id: 'classify-load', from: 'classify', to: 'load' },
    { id: 'load-debate', from: 'load', to: 'debate' },
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
    { id: 'skeptic-hasPragmatist', from: 'skeptic', to: 'hasPragmatist' },
    { id: 'hasPragmatist-pragmatist', from: 'hasPragmatist', to: 'pragmatist', branch: 'then' },
    { id: 'hasPragmatist-revise', from: 'hasPragmatist', to: 'revise', branch: 'else' },
    { id: 'pragmatist-hasCritic', from: 'pragmatist', to: 'hasCritic' },
    { id: 'hasCritic-critic', from: 'hasCritic', to: 'critic', branch: 'then' },
    { id: 'hasCritic-revise', from: 'hasCritic', to: 'revise', branch: 'else' },
    { id: 'critic-reroute', from: 'critic', to: 'reroute' },
    { id: 'reroute-switch', from: 'reroute', to: 'switch', branch: 'then' },
    { id: 'reroute-revise', from: 'reroute', to: 'revise', branch: 'else' },
    { id: 'switch-propose', from: 'switch', to: 'propose', label: 'rerouted' },
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
    { id: 'gate-finalize', from: 'gate', to: 'finalize', branch: 'approved' },
    { id: 'gate-stopped', from: 'gate', to: 'stopped', branch: 'rejected' },
    { id: 'escalate-propose', from: 'escalate', to: 'propose', label: 'next round' },
    { id: 'finalize-done', from: 'finalize', to: 'done' },
  ],
  demo: {
    context: { request: 'Fix the flaky login test that fails on CI about once in ten runs' },
    tools: {
      library: () => ({
        names: DEMO_LIBRARY.map((p) => p.name),
        summaries: DEMO_LIBRARY.map((p) => `${p.name}: ${p.description}`),
        catalog: Object.fromEntries(DEMO_LIBRARY.map(({ demo: _d, ...p }) => [p.name, p])),
      }),
      route: (s) => {
        const text = String(s.request).toLowerCase();
        const hit = DEMO_LIBRARY.find((p) =>
          (p.verbTriggers ?? []).some((t) => triggerMatches(text, t)),
        );
        return { suggested: hit?.name ?? 'new' };
      },
      validate: (s) => {
        const parsed = parseDraft(s.draft);
        return parsed.ok
          ? { errors: [], valid: true, pattern: (({ demo: _d, ...p }) => p)(parsed.value) }
          : { errors: parsed.errors, valid: false, pattern: {} };
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
        const request = String(s.request);
        const template = s.template as Record<string, unknown>;
        const draft = Object.keys(template ?? {}).length > 0 ? template : genericDraft(request);
        return {
          updates: {
            draft,
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
