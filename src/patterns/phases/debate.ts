/**
 * Reusable debate phases: the maestro's proposer/skeptic/pragmatist/critic
 * roster, pointed at a conclusion instead of a plan. Any pattern can add them
 * to avoid locking onto its first explanation:
 *
 * - hypothesesPhase: competing explanations up front, each with what would
 *   confirm or refute it, so evidence is gathered for AND against every one.
 * - challengePhase: before the conclusion is final, an isolated skeptic
 *   attacks it (complexity >= 2), a pragmatist keeps only the real objections
 *   (>= 3), real ones go back to research (bounded by maxDebateRounds), and at
 *   complexity 4 an independent second investigator's conclusion is reconciled
 *   with the first.
 *
 * Fragments return their state, nodes, edges and a phase; the pattern wires an
 * edge into `entry` and supplies where the fragment exits.
 */
import { MEMORY_NOTE } from './evidence.js';
import type { ScoreEdge, ScoreGroup, ScoreNode, StateField } from '../../core/types.js';
import {
  checkFindings,
  CITE_BY_ID,
  citesFindings,
  EVIDENCE_STATE,
  MERGE_FINDINGS,
} from './evidence.js';
import { applyRating, RATING_CHECK, RATING_DIRECTIVE, RATING_STATE } from './complexity.js';

export interface Fragment {
  readonly state: readonly StateField[];
  readonly nodes: readonly ScoreNode[];
  readonly edges: readonly ScoreEdge[];
  readonly group: ScoreGroup;
  /** Node to wire the incoming edge to. */
  readonly entry: string;
  /** Node to wire the outgoing edge from, when the fragment continues (default: entry). */
  readonly exit?: string;
}

/** Merge fragment state into a pattern's, keeping the pattern's own definition on name clashes. */
export function withState(
  own: readonly StateField[],
  ...fragments: readonly Fragment[]
): StateField[] {
  const out = [...own];
  for (const f of fragments.flatMap((x) => x.state)) {
    if (!out.some((s) => s.name === f.name)) out.push(f);
  }
  return out;
}

export const DEBATE_STATE: readonly StateField[] = [
  {
    name: 'complexity',
    type: 'number',
    description: '1..4 from the score; scales the debate roster',
  },
  {
    name: 'hypotheses',
    type: 'string[]',
    description: 'Competing explanations: "H1: claim | confirm if … | refute if …"',
  },
  {
    name: 'rulings',
    type: 'string[]',
    description: 'One per hypothesis: "H1: CONFIRMED | REFUTED | UNKNOWN — evidence"',
  },
  {
    name: 'objections',
    type: 'string[]',
    description: "The skeptic's concrete objections to the draft conclusion",
  },
  {
    name: 'objectionTriage',
    type: 'string[]',
    description: 'One per objection: "<objection>: REAL | THEORETICAL — reason"',
  },
  {
    name: 'realObjections',
    type: 'string[]',
    description: 'Objections worth more research',
  },
  { name: 'debateRounds', type: 'number' },
  { name: 'maxDebateRounds', type: 'number', initial: 2 },
  {
    name: 'secondOpinion',
    type: 'string',
    description: "An independent investigator's conclusion (complexity 4)",
  },
  {
    name: 'disagreements',
    type: 'string[]',
    description: 'Where the two investigators disagree, and how it was settled',
  },
  {
    name: 'unresolvedObjections',
    type: 'string[]',
    description: 'Objections still open when the debate reached maxDebateRounds',
  },
];

const debateState = (...names: string[]) => DEBATE_STATE.filter((f) => names.includes(f.name));

export interface HypothesesConfig {
  /** Field holding the question or problem. */
  readonly subject: string;
  /** Other fields the proposer should see (sub-questions, sources, symptoms…). */
  readonly context: readonly string[];
}

/** The hypothesis that the question's framing is wrong (no backslashes: expressions drop them). */
const NULL_HYPOTHESIS = '[Nn]one of (these|the above)|[Pp]remise[^|]*wrong';

/** Competing explanations before any evidence is gathered. */
export function hypothesesPhase(cfg: HypothesesConfig): Fragment {
  return {
    state: [...debateState('complexity', 'hypotheses', 'rulings'), ...RATING_STATE],
    entry: 'hypothesize',
    exit: 'applyRating',
    group: {
      id: 'hypothesesPhase',
      label: 'Competing hypotheses',
      description:
        'Every plausible explanation, each with what would confirm or refute it; how hard it is',
      nodes: ['hypothesize', 'applyRating'],
    },
    nodes: [
      {
        id: 'hypothesize',
        kind: 'agent',
        role: 'assessor',
        isolated: true,
        label: 'Propose hypotheses',
        directive: `You are the PROPOSER of competing hypotheses for \`${cfg.subject}\`. Before any evidence is read, list EVERY plausible answer or explanation, including the unwelcome ones and one that says the premise is wrong or the answer is "none of these". Write each \`hypotheses\` entry as "H<n>: <claim> | confirm if <evidence that would prove it> | refute if <evidence that would disprove it>". They must be distinct; the investigation will look for evidence for AND against each one, so do not rank them or pick a favourite.${cfg.context.includes('knownFacts') ? MEMORY_NOTE : ''}${RATING_DIRECTIVE}`,
        reads: [cfg.subject, ...cfg.context],
        writes: ['hypotheses', 'ratedComplexity'],
        retries: 2,
        complexityShift: 1,
        checks: [
          RATING_CHECK,
          {
            // A routine problem (rated or set at 1) needs fewer rivals than a hard one.
            expr: 'len(hypotheses) >= if(ratedComplexity == 1 || complexity == 1, 2, 3)',
            message:
              'Give at least 3 competing hypotheses (2 for a routine problem), including a "none of these" one.',
          },
          {
            expr: 'len(unique(hypotheses)) == len(hypotheses)',
            message: 'Each hypothesis must be distinct.',
          },
          {
            // Without a rival that the framing itself is wrong, the evidence can only pick among
            // the proposer's favourites.
            expr: `count(hypotheses, "${NULL_HYPOTHESIS}") >= 1`,
            message:
              'Include one hypothesis that says "none of these" or that the premise is wrong.',
          },
        ],
      },
      applyRating(),
    ],
    edges: [{ id: 'hypothesize-applyRating', from: 'hypothesize', to: 'applyRating' }],
  };
}

export interface ChallengeConfig {
  readonly subject: string;
  /** Field (string[]) with the evidence gathered so far. */
  readonly evidence: string;
  /** Field (string) with the draft conclusion. */
  readonly draft: string;
  /** Field (string[]) that research reads its targets from. */
  readonly gaps: string;
  /** Research node to send real objections to. */
  readonly reopen: string;
  /** Node to continue to once the conclusion stands. */
  readonly done: string;
  /** Fields the second investigator may use to research on its own (sources, sub-questions). */
  readonly research: readonly string[];
  /** Fields the skeptic, pragmatist and reconciler read with the draft (e.g. per-part answers). */
  readonly alongside?: readonly string[];
  /** A counter of the research loop to reset when objections reopen it (its own budget per round). */
  readonly resetOnReopen?: string;
  /** A string[] of parts of the subject (e.g. sub-questions): each objection names the one it bears on, "S<n>: …". */
  readonly about?: string;
}

/** Most objections one skeptic round may raise: the debate converges instead of growing. */
export const MAX_OBJECTIONS = 5;

/** Attack the draft conclusion; send real objections back to research; reconcile a second opinion. */
export function challengePhase(cfg: ChallengeConfig): Fragment {
  const { subject, evidence, draft, gaps, reopen, done } = cfg;
  const alongside = cfg.alongside ?? [];
  return {
    state: debateState(
      'complexity',
      'objections',
      'objectionTriage',
      'realObjections',
      'debateRounds',
      'maxDebateRounds',
      'secondOpinion',
      'disagreements',
      'unresolvedObjections',
    ).concat([
      // The second opinion's evidence joins the numbered findings (a pattern's own definitions win).
      {
        name: 'openObjections',
        type: 'string[]',
        description: 'Objections sent back to research, kept until research settles them',
      },
      { name: 'newFindings', type: 'string[]', description: 'Evidence found in this step' },
      { name: 'findings', type: 'string[]', description: 'All checked evidence, numbered F1, F2…' },
      ...EVIDENCE_STATE,
    ]),
    entry: 'useSkeptic',
    group: {
      id: 'challengePhase',
      label: 'Challenge the answer',
      description: 'Skeptic, pragmatist and a second investigator, scaled by complexity',
      nodes: [
        'useSkeptic',
        'challenge',
        'hasObjections',
        'roundsLeft',
        'keepOpen',
        'usePragmatist',
        'triageObjections',
        'keepAll',
        'anyReal',
        'reopen',
        'useSecond',
        'second',
        'checkSecond',
        'mergeSecond',
        'reconcile',
      ],
    },
    nodes: [
      {
        id: 'useSkeptic',
        kind: 'condition',
        label: 'Skeptic? (≥2)',
        expression: 'complexity >= 2',
      },
      {
        id: 'challenge',
        kind: 'agent',
        role: 'assessor',
        isolated: true,
        label: 'Skeptic',
        directive: `You are the SKEPTIC. Attack \`${draft}\` as the answer to \`${subject}\`, using only \`${evidence}\` and \`hypotheses\`. You are not a contrarian: each \`objections\` entry must be CONCRETE and checkable — a claim not backed by a cited item of \`${evidence}\`, a hypothesis dismissed without evidence against it, an alternative explanation the evidence also fits, or a path nobody followed (a caller, a config, a version, an environment). Say what research would settle it. An empty list is fine and better than invented concerns; no style comments. Give at most ${MAX_OBJECTIONS}, the ones most likely to change the answer first, and merge objections one piece of research would settle together.${cfg.about ? ` Start each one with the entry of \`${cfg.about}\` it bears on, by position: "S1: …" for the first (S0 for ${subject} as a whole).` : ''}`,
        reads: [subject, draft, ...alongside, evidence, 'hypotheses', 'rulings'],
        writes: ['objections'],
        retries: 2,
        complexityShift: 1,
        checks: [
          {
            expr: `len(objections) <= ${MAX_OBJECTIONS}`,
            message: `Give at most ${MAX_OBJECTIONS} objections: the ones most likely to change the answer, merged where one piece of research settles several.`,
          },
          ...(cfg.about
            ? [
                {
                  expr: 'len(unmatched(objections, "^S[0-9]+: ")) == 0',
                  message: `Start every objection with the entry of ${cfg.about} it bears on: "S1: …" (S0 for the whole).`,
                },
              ]
            : []),
        ],
      },
      {
        id: 'hasObjections',
        kind: 'condition',
        label: 'Objections?',
        expression: 'len(objections) > 0',
      },
      {
        id: 'roundsLeft',
        kind: 'condition',
        label: 'Research them? (rounds left)',
        expression: 'debateRounds < maxDebateRounds',
      },
      {
        id: 'usePragmatist',
        kind: 'condition',
        label: 'Pragmatist? (≥3)',
        expression: 'complexity >= 3',
      },
      {
        id: 'triageObjections',
        kind: 'agent',
        role: 'assessor',
        isolated: true,
        label: 'Pragmatist',
        directive: `You are the PRAGMATIST. For EVERY entry of \`objections\` write one \`objectionTriage\` entry, in order: "<objection, abbreviated>: REAL | THEORETICAL — <one-sentence reason>". REAL means it could change the answer to \`${subject}\` and research can settle it; THEORETICAL means it is unlikely or would not change the answer. Copy the REAL ones, verbatim, into \`realObjections\`. You are neither defending the draft nor siding with the skeptic.`,
        reads: [subject, draft, ...alongside, 'objections', evidence],
        writes: ['objectionTriage', 'realObjections'],
        retries: 2,
        checks: [
          {
            expr: 'len(objectionTriage) == len(objections)',
            message: 'Triage EVERY objection: one objectionTriage entry per objection.',
          },
          {
            expr: 'subset(realObjections, objections)',
            message: 'realObjections must be copied verbatim from objections.',
          },
        ],
      },
      {
        id: 'keepOpen',
        kind: 'compute',
        label: 'Report open objections',
        // Out of rounds, not out of objections: the REAL ones are said in the result, not dropped.
        assign: [{ field: 'unresolvedObjections', expr: 'realObjections' }],
      },
      {
        id: 'keepAll',
        kind: 'compute',
        label: 'Keep every objection',
        assign: [{ field: 'realObjections', expr: 'objections' }],
      },
      {
        id: 'anyReal',
        kind: 'condition',
        label: 'Real objections?',
        expression: 'len(realObjections) > 0',
      },
      {
        id: 'reopen',
        kind: 'compute',
        label: 'Research objections',
        assign: [
          { field: gaps, expr: 'realObjections' },
          // Kept until research settles them: the next assessment cannot quietly drop them.
          { field: 'openObjections', expr: 'realObjections' },
          { field: 'debateRounds', expr: 'debateRounds + 1' },
          ...(cfg.resetOnReopen ? [{ field: cfg.resetOnReopen, expr: '0' }] : []),
        ],
      },
      {
        id: 'useSecond',
        kind: 'condition',
        label: 'Second investigator? (4)',
        expression: 'complexity >= 4 && empty(secondOpinion)',
      },
      {
        id: 'second',
        kind: 'agent',
        role: 'assessor',
        capabilities: ['web', 'mcp'],
        label: 'Second investigator',
        // Another model family: its mistakes are less likely to be the first one's.
        otherModel: true,
        directive: `You are an INDEPENDENT second investigator. Answer \`${subject}\` yourself, from scratch, without seeing the first investigator's answer or evidence. Test every entry of \`hypotheses\` against the sources yourself. Record every piece of evidence you rely on in \`newFindings\` ("path:line — fact \`quote\`", or "source | location — fact"): it is checked like the first investigator's. Write your conclusion, with a verdict per hypothesis, in \`secondOpinion\`.`,
        reads: [subject, 'hypotheses', ...cfg.research],
        writes: ['secondOpinion', 'newFindings'],
        cites: 'newFindings',
        retries: 2,
        complexityShift: 1,
        checks: [
          { expr: 'len(secondOpinion) > 0', message: 'Write your conclusion.' },
          {
            expr: 'len(newFindings) > 0',
            message: 'Record the evidence you rely on in newFindings.',
          },
        ],
      },
      // The second opinion's evidence is checked and numbered like the rest, so it can be cited.
      checkFindings('checkSecond'),
      {
        id: 'mergeSecond',
        kind: 'compute',
        label: 'Record its evidence',
        assign: [...MERGE_FINDINGS],
      },
      {
        id: 'reconcile',
        kind: 'agent',
        role: 'assessor',
        isolated: true,
        label: 'Reconcile',
        directive: `Two investigators answered \`${subject}\` independently: \`${draft}\` and \`secondOpinion\`. Rewrite \`${draft}\` as the reconciled answer, keeping only claims backed by evidence from either (both are in \`${evidence}\` now). ${CITE_BY_ID} Then update \`rulings\` (one per hypothesis, "H<n>: CONFIRMED | REFUTED | UNKNOWN — evidence"). List every point where they disagreed, and how it was settled or why it is still open, in \`disagreements\`.`,
        reads: [
          subject,
          draft,
          ...alongside,
          'secondOpinion',
          evidence,
          ...(evidence === 'findings' || evidence === 'findingsBrief' ? [] : ['findingsBrief']),
          'hypotheses',
          'rulings',
        ],
        writes: [draft, 'rulings', 'disagreements'],
        retries: 2,
        complexityShift: 1,
        checks: [
          {
            expr: 'len(rulings) == len(hypotheses)',
            message: 'Give exactly one ruling per hypothesis.',
          },
          citesFindings(draft),
        ],
      },
    ],
    edges: [
      { id: 'useSkeptic-challenge', from: 'useSkeptic', to: 'challenge', branch: 'then' },
      { id: 'useSkeptic-done', from: 'useSkeptic', to: done, branch: 'else', label: 'no debate' },
      { id: 'challenge-hasObjections', from: 'challenge', to: 'hasObjections' },
      {
        id: 'hasObjections-usePragmatist',
        from: 'hasObjections',
        to: 'usePragmatist',
        branch: 'then',
      },
      { id: 'hasObjections-useSecond', from: 'hasObjections', to: 'useSecond', branch: 'else' },
      { id: 'keepOpen-useSecond', from: 'keepOpen', to: 'useSecond' },
      {
        id: 'usePragmatist-triage',
        from: 'usePragmatist',
        to: 'triageObjections',
        branch: 'then',
      },
      { id: 'usePragmatist-keepAll', from: 'usePragmatist', to: 'keepAll', branch: 'else' },
      { id: 'triage-anyReal', from: 'triageObjections', to: 'anyReal' },
      { id: 'keepAll-anyReal', from: 'keepAll', to: 'anyReal' },
      { id: 'anyReal-roundsLeft', from: 'anyReal', to: 'roundsLeft', branch: 'then' },
      { id: 'roundsLeft-reopen', from: 'roundsLeft', to: 'reopen', branch: 'then' },
      { id: 'roundsLeft-keepOpen', from: 'roundsLeft', to: 'keepOpen', branch: 'else' },
      { id: 'anyReal-useSecond', from: 'anyReal', to: 'useSecond', branch: 'else' },
      { id: 'reopen-research', from: 'reopen', to: reopen, label: 'research objections' },
      { id: 'useSecond-second', from: 'useSecond', to: 'second', branch: 'then' },
      { id: 'useSecond-done', from: 'useSecond', to: done, branch: 'else' },
      { id: 'second-check', from: 'second', to: 'checkSecond' },
      { id: 'checkSecond-merge', from: 'checkSecond', to: 'mergeSecond' },
      { id: 'mergeSecond-reconcile', from: 'mergeSecond', to: 'reconcile' },
      { id: 'reconcile-done', from: 'reconcile', to: done },
    ],
  };
}
