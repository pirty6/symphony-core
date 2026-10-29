/**
 * Evidence that can be checked. Findings are written as "path:line — fact `quote`";
 * a tool step checks each one against the workspace before it is recorded (the file,
 * the line and the quote must be real), and the engine numbers what passes (F1, F2…)
 * so answers can cite findings by id and a check can prove every cited id exists.
 */
import type { AcceptanceCheck, ScoreNode, StateField } from '../../core/types.js';

export const EVIDENCE_STATE: readonly StateField[] = [
  {
    name: 'rejectedFindings',
    type: 'string[]',
    description: 'Findings from the last step whose citation did not hold',
  },
  {
    name: 'unverified',
    type: 'string[]',
    description: 'Every finding dropped because its file, line or quote was not real',
  },
];

/** Check the step's new findings against the workspace; failures go to rejectedFindings. */
export function checkFindings(id: string, field = 'newFindings'): ScoreNode {
  return {
    id,
    kind: 'tool',
    label: 'Check citations',
    tool: 'evidence.check',
    inputs: { findings: field },
    output: { valid: field, invalid: 'rejectedFindings' },
    maxVisits: 200,
  };
}

/** Record checked findings with ids (skipping ones already known) and keep the rejected. */
export const MERGE_FINDINGS = [
  {
    field: 'findings',
    expr: 'findings + numbered(without(unique(newFindings), unnumbered(findings)), len(findings) + 1)',
  },
  { field: 'unverified', expr: 'unverified + rejectedFindings' },
] as const;

/** Answers cite findings by id, e.g. [F3]. */
export const CITE_BY_ID =
  'Cite the findings you rely on by their ids in brackets, e.g. [F3]; every claim needs at least one, and only ids that exist in `findings` count.';

export function citesFindings(field: string): AcceptanceCheck {
  return {
    expr: `len(refs(${field})) > 0 && subset(refs(${field}), ids(findings))`,
    message: `Cite findings by their ids in ${field} (e.g. [F3]), using only ids that exist in findings.`,
  };
}
