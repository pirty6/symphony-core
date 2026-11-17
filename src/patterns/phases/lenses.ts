/**
 * The pillar lenses (core/pillars.ts): one sub-algorithm per pillar, played as the parts of one
 * fanned-out step. The engine scans the change and briefs each lens (its rulebook and its
 * leads); one reviewer per lens judges only that pillar, and the engine checks that each lens
 * says what it examined, and that the Tests lens judges every unit of the critical path.
 */
import { lensBrief, pillarById, type PillarId } from '../../core/pillars.js';
import type {
  AcceptanceCheck,
  DemoScript,
  ScoreEdge,
  ScoreNode,
  StateField,
} from '../../core/types.js';
import { CATEGORIES, findingChecks } from './reviewRules.js';

/** The lenses a change is looked at through; Correctness is the pattern's own reviewers. */
export const CHANGE_PILLARS: readonly PillarId[] = [
  'SECURITY',
  'CLEAN',
  'TESTS',
  'PERFORMANCE',
  'DETERMINISM',
];

export interface LensConfig {
  /** The lenses to look through, in this order. */
  readonly pillars: readonly PillarId[];
  /** The state field holding the git range of the change ('' for the uncommitted changes). */
  readonly range: string;
  /** What else the reviewers read: the change's target, intent, claims, summary. */
  readonly reads: readonly string[];
  /** Where the phase goes when it is done (or has no lens to play). */
  readonly next: string;
  /** How the checked lens findings join the pattern's own (assignments of a compute node). */
  readonly merge: readonly { readonly field: string; readonly expr: string }[];
}

export const LENS_STATE: readonly StateField[] = [
  {
    name: 'lenses',
    type: 'string[]',
    description: "One brief per pillar lens: its rulebook and the scan's leads",
  },
  {
    name: 'testBreaks',
    type: 'string[]',
    description: 'Branches, loops, sleeps or clocks inside the changed test bodies (engine-found)',
  },
  {
    name: 'lensFindings',
    type: 'string[]',
    description: 'Issues the lenses found, in the review format with the rule id',
  },
  {
    name: 'lensRejected',
    type: 'string[]',
    description: 'Lens findings whose citation did not hold in this checkout',
  },
  {
    name: 'lensNotes',
    type: 'string[]',
    description: 'One per lens: "PILLAR: ISSUES|NONE — what it examined"',
  },
  {
    name: 'criticalUnits',
    type: 'string[]',
    description:
      'The Tests lens: "U<n> path:line — DOMAIN|CONTROLLER|TRIVIAL|OVERCOMPLICATED — why", per changed unit',
  },
  {
    name: 'unitVerdicts',
    type: 'string[]',
    description:
      'Per critical unit, in order: "U<n> MEANINGFUL|WEAK|UNTESTED|SPLIT|NONE NEEDED — the test that would fail, or why"',
  },
  { name: 'lensAgents', type: 'number', initial: 6, description: 'Lenses played at once' },
  { name: 'lensDone', type: 'boolean', description: 'The lenses have looked at this change' },
];

const UNIT_KINDS = 'DOMAIN|CONTROLLER|TRIVIAL|OVERCOMPLICATED';
const UNIT_VERDICTS = 'MEANINGFUL|WEAK|UNTESTED|SPLIT|NONE NEEDED';

const lensDirective = (range: string): string =>
  `You review a change (git diff \`${range}\`, or git diff HEAD when it is empty; the workspace is read-only) through the ONE pillar lens in \`lenses\`: its brief names the pillar, its rules, and the leads the engine's scan found. Judge that pillar only: other lenses cover the rest. Check every lead and report only the real issues.
- Write each issue in \`lensFindings\` as "path:line — [CATEGORY] [HIGH|MEDIUM|LOW] [RULE-ID] problem \`exact quote of that line\`", CATEGORY one of the lens's categories (${CATEGORIES.split('|').join(', ')}), RULE-ID the rule it breaks (a CLEAN finding names a Clean Code smell id such as G5 or F1). An empty list is right when the change is sound for this pillar.
- Write one \`lensNotes\` entry per lens, in order: "PILLAR: ISSUES — …" when you report a finding, else "PILLAR: NONE — what you examined, path:line".
- Only for the TESTS lens: follow its critical-path steps. List each function or class the change adds or edits in production code in \`criticalUnits\` as "U<n> path:line — ${UNIT_KINDS} — why" (U1 first), and for each, in order, a \`unitVerdicts\` entry "U<n> ${UNIT_VERDICTS} — the test path:line that would fail if it broke, or why". DOMAIN units need MEANINGFUL unit tests; CONTROLLER units an integration test; TRIVIAL ones are NONE NEEDED; OVERCOMPLICATED ones are SPLIT. WEAK: a test runs it but would pass without the change. Every WEAK or UNTESTED unit is also a [TEST] finding, every SPLIT one a [DESIGN] finding. Other lenses leave both lists empty.`;

const LENS_CHECKS: readonly AcceptanceCheck[] = [
  ...findingChecks('lensFindings'),
  {
    expr: 'heads(lensNotes, "^[A-Z]+") == heads(lenses, "^[A-Z]+") && len(unmatched(lensNotes, "^[A-Z]+: (ISSUES|NONE) — ")) == 0',
    message:
      'Write one lensNotes entry per lens of lenses, in order: "PILLAR: ISSUES|NONE — what you examined, path:line".',
  },
  {
    expr: 'len(criticalUnits) + len(unitVerdicts) == 0 || includes(heads(lenses, "^[A-Z]+"), "TESTS")',
    message: 'Only the TESTS lens writes criticalUnits and unitVerdicts.',
  },
  {
    expr: `len(unmatched(criticalUnits, "^U[0-9]+ .+:[0-9]+ — (${UNIT_KINDS}) — ")) == 0 && heads(criticalUnits, "^U[0-9]+") == seq("U", len(criticalUnits))`,
    message: `Write criticalUnits as "U<n> path:line — ${UNIT_KINDS} — why", numbered from U1.`,
  },
  {
    expr: `len(unmatched(unitVerdicts, "^U[0-9]+ (${UNIT_VERDICTS}) — ")) == 0 && heads(unitVerdicts, "^U[0-9]+ ") == heads(criticalUnits, "^U[0-9]+ ")`,
    message: `Write one unitVerdicts entry per criticalUnits entry, with its id, in order: "U<n> ${UNIT_VERDICTS} — …".`,
  },
  {
    expr: 'count(unitVerdicts, "^U[0-9]+ (WEAK|UNTESTED|SPLIT) ") <= count(lensFindings, " — [[](TEST|DESIGN)] ")',
    message:
      'Write each WEAK or UNTESTED unit as a [TEST] finding, and each SPLIT one as a [DESIGN] finding, in lensFindings too.',
  },
];

/** The phase's nodes and edges: scan, then the lenses, then their findings checked and merged. */
export function lensPhase(cfg: LensConfig): {
  readonly entry: string;
  readonly nodes: readonly ScoreNode[];
  readonly edges: readonly ScoreEdge[];
} {
  const nodes: ScoreNode[] = [
    // Once per change: a pattern that judges again after research does not look again.
    { id: 'lensDue', kind: 'condition', label: 'Lenses not played yet?', expression: '!lensDone' },
    {
      id: 'lensScan',
      kind: 'tool',
      label: 'Brief the pillar lenses',
      tool: 'pillars.scan',
      args: { pillars: [...cfg.pillars] },
      inputs: { range: cfg.range },
      output: { lenses: 'lenses', testBreaks: 'testBreaks' },
    },
    { id: 'hasLenses', kind: 'condition', label: 'Lenses to play?', expression: 'len(lenses) > 0' },
    {
      id: 'lens',
      kind: 'agent',
      role: 'assessor',
      label: 'Look through each pillar',
      directive: lensDirective(cfg.range),
      reads: [...cfg.reads, cfg.range, 'lenses'],
      writes: ['lensFindings', 'lensNotes', 'criticalUnits', 'unitVerdicts'],
      cites: 'lensFindings',
      fanOut: { over: 'lenses', per: 1, agents: 'lensAgents' },
      maxVisits: 1,
      retries: 2,
      checks: [...LENS_CHECKS],
    },
    {
      // Its own rejected list: a pattern without investigate's evidence fields can play it.
      id: 'checkLens',
      kind: 'tool',
      label: 'Check citations',
      tool: 'evidence.check',
      inputs: { findings: 'lensFindings' },
      output: { valid: 'lensFindings', invalid: 'lensRejected' },
    },
    {
      id: 'mergeLens',
      kind: 'compute',
      label: 'Record what the lenses found',
      assign: [...cfg.merge, { field: 'lensDone', expr: 'true' }],
    },
    {
      id: 'noLens',
      kind: 'compute',
      label: 'No lens to play',
      assign: [{ field: 'lensDone', expr: 'true' }],
    },
  ];
  const edges: ScoreEdge[] = [
    { id: 'lensDue-scan', from: 'lensDue', to: 'lensScan', branch: 'then' },
    { id: 'lensDue-next', from: 'lensDue', to: cfg.next, branch: 'else' },
    { id: 'lensScan-has', from: 'lensScan', to: 'hasLenses' },
    { id: 'has-lens', from: 'hasLenses', to: 'lens', branch: 'then' },
    { id: 'has-none', from: 'hasLenses', to: 'noLens', branch: 'else' },
    { id: 'noLens-next', from: 'noLens', to: cfg.next },
    { id: 'lens-check', from: 'lens', to: 'checkLens' },
    { id: 'checkLens-merge', from: 'checkLens', to: 'mergeLens' },
    { id: 'mergeLens-next', from: 'mergeLens', to: cfg.next },
  ];
  return { entry: 'lensDue', nodes, edges };
}

// ── the critical path, named before an edit ───────────────────────

/** Where a step that plans an edit names the critical path and the tests it needs. */
export const CRITICAL_PATH_FIELD: StateField = {
  name: 'criticalPath',
  type: 'string[]',
  description:
    'Each unit the edit adds or changes: "U<n> path — DOMAIN|CONTROLLER|TRIVIAL|OVERCOMPLICATED — test: the test that proves it" (TRIVIAL: "— none: why")',
};

/** For a planning step: the Tests lens's quadrants, applied before the code exists. */
export const CRITICAL_PATH_DIRECTIVE = ` Name the critical path in \`criticalPath\`, one entry per function or class the edit adds or changes: "U<n> path — ${UNIT_KINDS} — test: the test that proves it". DOMAIN (decides much, few collaborators) gets unit tests of its outcomes and edge cases; CONTROLLER (coordinates many collaborators) an integration test; TRIVIAL needs none ("— none: why"); OVERCOMPLICATED is split first (the decisions apart from the wiring). Each test is one behaviour, with no if, loop or try/finally inside it, named for its scenario.`;

export const CRITICAL_PATH_CHECKS: readonly AcceptanceCheck[] = [
  { expr: 'len(criticalPath) > 0', message: 'Name the critical path in criticalPath.' },
  {
    expr: `len(unmatched(criticalPath, "^U[0-9]+ [^ ]+ — (${UNIT_KINDS}) — ")) == 0 && heads(criticalPath, "^U[0-9]+") == seq("U", len(criticalPath))`,
    message: `Write criticalPath as "U<n> path — ${UNIT_KINDS} — test: …", numbered from U1.`,
  },
  {
    expr: 'count(criticalPath, " — (DOMAIN|CONTROLLER) — test: ") == count(criticalPath, " — (DOMAIN|CONTROLLER) — ")',
    message: 'Name the test for each DOMAIN or CONTROLLER unit: "— test: the test that proves it".',
  },
];

// ── for a pattern's offline demo ──────────────────────────────────

/** Each lens finds nothing: what it examined, and no critical unit. */
const quietLens: NonNullable<DemoScript['agents']>[string] = (s) => ({
  updates: {
    lensFindings: [],
    lensNotes: [`${String((s.lenses as string[])[0]).split(' ')[0]}: NONE — read the change`],
    criticalUnits: [],
    unitVerdicts: [],
  },
  verdict: { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'sound' },
});

/** The lenses and the test rules in an offline demo: briefed from the rulebooks, all quiet. */
export const DEMO_LENSES: {
  readonly tools: NonNullable<DemoScript['tools']>;
  readonly agents: NonNullable<DemoScript['agents']>;
} = {
  tools: {
    lensScan: () => ({
      lenses: CHANGE_PILLARS.map((p) => lensBrief(pillarById(p), [])),
      testBreaks: [],
    }),
    scanTests: () => ({ testBreaks: [] }),
    checkLens: (s) => ({ valid: s.lensFindings, invalid: [] }),
  },
  agents: { lens: quietLens },
};
