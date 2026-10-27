/**
 * Core types. Everything here is plain JSON-serializable data except
 * `Pattern.demo`, which holds scripted responses for the offline provider
 * and is dropped by the compiler.
 *
 *   Pattern (TypeScript, reusable)
 *     -> compileScore(pattern, { goal, context })
 *   ExecutableScore (read-only plan, content-hashed id)
 *     -> createEngine(score) / advance(state, resolution)   (pure)
 *   Performance (what happened: steps, events, AI transcripts)
 */

export type Role = 'assessor' | 'executor';
export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'object';

export const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'number',
  'boolean',
  'string[]',
  'number[]',
  'object',
];

export interface StateField {
  readonly name: string;
  readonly type: FieldType;
  readonly description?: string;
  /** Initial value; defaults to the zero value of `type`. */
  readonly initial?: unknown;
}

// ── Nodes ──────────────────────────────────────────────────────────

interface NodeBase {
  readonly id: string;
  readonly label: string;
  /** Hard cap on how many times this node may be entered in one run. */
  readonly maxVisits?: number;
}

/** Entry point. Pure routing. */
export interface StartNode extends NodeBase {
  readonly kind: 'start';
}

/** AI runs here and only here. */
export interface AgentNode extends NodeBase {
  readonly kind: 'agent';
  readonly role: Role;
  readonly directive: string;
  /** State keys shown to the agent. */
  readonly reads: readonly string[];
  /** State keys the agent must return when outcome is 'applied'. */
  readonly writes: readonly string[];
  /** Extra attempts after an invalid response. Default 1. */
  readonly retries?: number;
}

/** Deterministic state update: field <- expression, evaluated in order. */
export interface ComputeNode extends NodeBase {
  readonly kind: 'compute';
  readonly assign: readonly { readonly field: string; readonly expr: string }[];
}

/** Branch on a guard expression. Outgoing edges use branch 'then' / 'else'. */
export interface ConditionNode extends NodeBase {
  readonly kind: 'condition';
  readonly expression: string;
}

/** Human-in-the-loop gate. Edges may use branch 'approved' / 'rejected'. */
export interface ApprovalNode extends NodeBase {
  readonly kind: 'approval';
  readonly message: string;
  /** State keys the human provides when approving (may be empty). */
  readonly writes: readonly string[];
}

export interface EndNode extends NodeBase {
  readonly kind: 'end';
  readonly outcome?: 'success' | 'failed' | 'partial';
}

export type ScoreNode =
  | StartNode
  | AgentNode
  | ComputeNode
  | ConditionNode
  | ApprovalNode
  | EndNode;
export type NodeKind = ScoreNode['kind'];

export type Branch = 'then' | 'else' | 'approved' | 'rejected';

export interface ScoreEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Guard expression; edges are tried in declared order, first match wins. */
  readonly guard?: string;
  readonly branch?: Branch;
  readonly label?: string;
}

// ── Pattern (authoring) ────────────────────────────────────────────

export interface NodeResult {
  readonly updates: Readonly<Record<string, unknown>>;
  readonly verdict: MoveVerdict;
}

/** Offline scripted response for an agent node: (state, visit index) -> result. */
export type DemoResponder = (state: Readonly<Record<string, unknown>>, visit: number) => NodeResult;

export interface DemoScript {
  readonly agents?: Readonly<Record<string, DemoResponder>>;
  /** Values the scripted human gives at approval nodes, per visit. */
  readonly approvals?: Readonly<
    Record<string, (state: Readonly<Record<string, unknown>>, visit: number) => ApprovalAnswer>
  >;
  readonly goal?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface ApprovalAnswer {
  readonly approved: boolean;
  readonly updates?: Readonly<Record<string, unknown>>;
}

export interface PatternGraph {
  readonly state: readonly StateField[];
  readonly nodes: readonly ScoreNode[];
  readonly edges: readonly ScoreEdge[];
  readonly start: string;
  /** Global step budget. Default 100. */
  readonly maxSteps?: number;
}

export interface Pattern extends PatternGraph {
  readonly name: string;
  readonly description: string;
  readonly verbTriggers?: readonly string[];
  /** State keys the caller must provide through `context` at compile time. */
  readonly requiredContext: readonly string[];
  readonly demo?: DemoScript;
}

// ── ExecutableScore (plan) ─────────────────────────────────────────

export interface ExecutableScore extends PatternGraph {
  readonly schemaVersion: 2;
  /** hash(everything except id + generatedAt). */
  readonly id: string;
  readonly pattern: string;
  readonly description: string;
  readonly goal: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly initialState: Readonly<Record<string, unknown>>;
  readonly maxSteps: number;
  readonly generatedAt: string;
}

// ── Verdicts and transcripts ───────────────────────────────────────

export type VerdictOutcome = 'applied' | 'failed' | 'skipped';

export interface MoveVerdict {
  readonly outcome: VerdictOutcome;
  readonly confidence: number;
  readonly shouldTerminate: boolean;
  readonly reason: string;
}

export interface ToolCallRecord {
  readonly name: string;
  readonly args?: unknown;
  readonly ok?: boolean;
  readonly denied?: string;
}

/** Everything the AI saw and said for one attempt, for audit and replay. */
export interface AiTranscript {
  readonly provider: string;
  readonly model?: string;
  readonly prompt: string;
  readonly output: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly startedAt?: string;
  readonly completedAt?: string;
}

// ── Engine: pauses and resolutions ─────────────────────────────────

export interface AgentPause {
  readonly kind: 'agent';
  readonly pauseId: string;
  readonly step: number;
  readonly nodeId: string;
  readonly role: Role;
  readonly label: string;
  readonly directive: string;
  readonly goal: string;
  readonly context: Readonly<Record<string, unknown>>;
  /** Snapshot of `reads` keys. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly outputSchema: readonly StateField[];
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Validation errors from the previous attempt, if any. */
  readonly feedback?: readonly string[];
  readonly moveKey: string;
}

export interface ApprovalPause {
  readonly kind: 'approval';
  readonly pauseId: string;
  readonly step: number;
  readonly nodeId: string;
  readonly label: string;
  readonly message: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly outputSchema: readonly StateField[];
  readonly feedback?: readonly string[];
  readonly moveKey: string;
}

export type Pause = AgentPause | ApprovalPause;

export interface AgentResolution {
  readonly kind: 'agent';
  readonly pauseId: string;
  /** Unvalidated: the engine checks shape before using it. */
  readonly result: unknown;
  readonly transcript?: AiTranscript;
  /** Workspace fingerprint after the node ran (e.g. git HEAD + diff hash). */
  readonly envHash?: string;
  readonly at?: string;
}

export interface ApprovalResolution {
  readonly kind: 'approval';
  readonly pauseId: string;
  readonly approved: boolean;
  readonly updates?: Readonly<Record<string, unknown>>;
  readonly by?: string;
  readonly at?: string;
}

export interface CancelResolution {
  readonly kind: 'cancel';
  readonly pauseId: string;
  readonly reason: string;
  readonly at?: string;
}

export type Resolution = AgentResolution | ApprovalResolution | CancelResolution;

// ── Events (returned by the engine, never side effects) ────────────

export interface StateChange {
  readonly key: string;
  readonly before: unknown;
  readonly after: unknown;
}

export type EngineEvent =
  | {
      readonly type: 'run-started';
      readonly scoreId: string;
      readonly state: Record<string, unknown>;
    }
  | {
      readonly type: 'node-entered';
      readonly step: number;
      readonly nodeId: string;
      readonly kind: NodeKind;
      readonly stateHash: string;
      readonly moveKey: string;
    }
  | {
      readonly type: 'guard-evaluated';
      readonly nodeId: string;
      readonly edgeId?: string;
      readonly expression: string;
      readonly result: boolean;
    }
  | {
      readonly type: 'edge-taken';
      readonly edgeId: string;
      readonly from: string;
      readonly to: string;
      /** State keys written by the node just left (the data travelling on this edge). */
      readonly carried: readonly string[];
      readonly values: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'paused'; readonly pause: Pause }
  | {
      readonly type: 'response-rejected';
      readonly nodeId: string;
      readonly attempt: number;
      readonly errors: readonly string[];
    }
  | {
      readonly type: 'node-completed';
      readonly step: number;
      readonly nodeId: string;
      readonly changes: readonly StateChange[];
      readonly verdict?: MoveVerdict;
      readonly stateHash: string;
    }
  | {
      readonly type: 'run-completed';
      readonly outcome: PerformanceOutcome;
      readonly reason: string;
    }
  | { readonly type: 'run-failed'; readonly error: string; readonly nodeId?: string };

// ── Performance (record) ───────────────────────────────────────────

export type PerformanceOutcome = 'success' | 'partial' | 'failed' | 'cancelled' | 'in-progress';

export interface PerformedStep {
  readonly step: number;
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly moveKey: string;
  readonly stateHashBefore: string;
  readonly stateHashAfter: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly changes: readonly StateChange[];
  /** Accepted updates exactly as returned (agent) or provided (approval); used for replay. */
  readonly updates?: Readonly<Record<string, unknown>>;
  readonly envHash?: string;
  readonly verdict?: MoveVerdict;
  readonly attempts?: readonly {
    readonly errors: readonly string[];
    readonly transcript?: AiTranscript;
  }[];
  readonly transcript?: AiTranscript;
  readonly approval?: { readonly approved: boolean; readonly by?: string };
  readonly at?: string;
}

export interface Performance {
  readonly schemaVersion: 2;
  readonly scoreId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: PerformanceOutcome;
  readonly reason?: string;
  readonly finalState: Readonly<Record<string, unknown>>;
  readonly steps: readonly PerformedStep[];
  /** Full ordered event log; enough to replay the run visually. */
  readonly events: readonly EngineEvent[];
}

/** Score + Performance persisted together: the audit artifact. */
export interface SavedRun {
  readonly schemaVersion: 2;
  readonly score: ExecutableScore;
  readonly performance: Performance;
}
