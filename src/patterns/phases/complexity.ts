/**
 * Complexity rated from the problem itself. When no complexity was chosen for a
 * run, its `complexity` field starts at 0 ("auto"); an early assessor rates the
 * problem with this rubric and `applyRating` sets it. That picks the model tier
 * for the rest of the run (with each step's complexityShift) and how deep the
 * debate goes. A chosen complexity always wins.
 */
import type { AcceptanceCheck, ScoreNode, StateField } from '../../core/types.js';

export const RATING_STATE: readonly StateField[] = [
  {
    name: 'ratedComplexity',
    type: 'number',
    description: 'How hard the problem is, 1-4, rated before the work starts',
  },
];

export const RATING_DIRECTIVE =
  ' Also rate how hard the problem is in `ratedComplexity`, choosing the LOWEST level that covers it: 1 = one obvious place to look, a known answer or a one-line change; 2 = a few places, some judgement; 3 = cross-cutting, ambiguous, several plausible causes or designs, or it needs experiments; 4 = novel or high-stakes, where even the framing of the problem is in doubt.';

export const RATING_CHECK: AcceptanceCheck = {
  expr: 'includes([1, 2, 3, 4], ratedComplexity)',
  message: 'ratedComplexity must be 1, 2, 3 or 4.',
};

/** Use the rating unless a complexity was chosen for the run. */
export function applyRating(id = 'applyRating'): ScoreNode {
  return {
    id,
    kind: 'compute',
    label: 'Set complexity',
    assign: [{ field: 'complexity', expr: 'if(complexity == 0, ratedComplexity, complexity)' }],
  };
}
