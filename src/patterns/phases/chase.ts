/**
 * Closing what is still open with targeted research: a research step, an engine check of what it
 * cites, and a compute that records what held. investigate chases its gaps and the objections
 * sent back to it this way; review chases the claims it could not settle and the objections its
 * debate sent back. The loop around it (when to chase, how many rounds) is the pattern's.
 */
import type { AcceptanceCheck, AgentNode, ScoreNode } from '../../core/types.js';
import { checkFindings } from './evidence.js';

export interface ChaseConfig {
  /** Step ids: the research, its citation check, and the merge. */
  readonly ids: { readonly chase: string; readonly check: string; readonly merge: string };
  readonly label: string;
  readonly mergeLabel: string;
  readonly directive: string;
  readonly reads: readonly string[];
  /** The string[] field the research writes its cited facts to, checked by the engine. */
  readonly notes: string;
  /** Checks of the pattern's own, before the shared ones (every query recorded, a fact per item). */
  readonly checks?: readonly AcceptanceCheck[];
  readonly capabilities?: AgentNode['capabilities'];
  readonly fanOut?: AgentNode['fanOut'];
  /** Whether what held is remembered for later runs as it is checked. */
  readonly remember?: boolean;
  /** How what held is recorded (the merge step's assignments). */
  readonly merge: Extract<ScoreNode, { kind: 'compute' }>['assign'];
}

export interface Chase {
  readonly chase: ScoreNode;
  readonly check: ScoreNode;
  readonly merge: ScoreNode;
}

/** The three steps of a chase, apart, so a pattern places them where its graph needs them. */
export function chaseSteps(cfg: ChaseConfig): Chase {
  return {
    chase: {
      id: cfg.ids.chase,
      kind: 'agent',
      role: 'assessor',
      label: cfg.label,
      ...(cfg.capabilities ? { capabilities: cfg.capabilities } : {}),
      ...(cfg.fanOut ? { fanOut: cfg.fanOut } : {}),
      directive: cfg.directive,
      reads: [...cfg.reads],
      writes: ['queries', cfg.notes],
      cites: cfg.notes,
      retries: 2,
      checks: [
        ...(cfg.checks ?? []),
        {
          expr: 'len(queries) > 0',
          message: 'Record every query, command or tool call you made in queries.',
        },
        {
          expr: `len(${cfg.notes}) > 0`,
          message:
            'Report a finding for every gap, even if it is where you looked without success.',
        },
      ],
    },
    check: checkFindings(cfg.ids.check, cfg.notes, cfg.remember ?? true),
    merge: { id: cfg.ids.merge, kind: 'compute', label: cfg.mergeLabel, assign: cfg.merge },
  };
}
