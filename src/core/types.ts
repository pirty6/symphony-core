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
/** Task difficulty; picks the model tier (1 fast/cheap .. 4 strongest) and the debate depth. */
export type Complexity = 1 | 2 | 3 | 4;
/** 0 classical .. 4 free jazz. See core/jazz.ts. */
export type Improvisation = 0 | 1 | 2 | 3 | 4;
/** Extra sources an agent node may use beyond the workspace: web search/fetch and MCP servers. */
export type Capability = 'web' | 'mcp';
export const CAPABILITIES: readonly Capability[] = ['web', 'mcp'];

/** A rule an agent answer must satisfy, evaluated on state merged with the answer's updates. */
export interface AcceptanceCheck {
  readonly expr: string;
  /** Told to the agent when the check fails. */
  readonly message: string;
}
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
  /** Deterministic acceptance rules; an answer failing any is rejected and re-asked. */
  readonly checks?: readonly AcceptanceCheck[];
  readonly capabilities?: readonly Capability[];
  /** Fixed model tier for this node; otherwise state.complexity, then the score's. */
  readonly complexity?: Complexity;
  /** No workspace tools at all: the agent works only from its input. */
  readonly isolated?: boolean;
  /**
   * Solo point: from Swing (improvisation >= 2) the AI chooses which labelled
   * out edge to take. Below that the first edge (the written melody) is played.
   */
  readonly solo?: boolean;
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
  /** State keys to show the human before they decide. */
  readonly shows?: readonly string[];
}

/**
 * Deterministic I/O performed by the runtime, not by AI (e.g. list every file in the repo).
 * The result is recorded, so replay never re-runs the tool.
 */
export interface ToolNode extends NodeBase {
  readonly kind: 'tool';
  /** Registered tool name, e.g. 'repo.files'. */
  readonly tool: string;
  readonly args?: Readonly<Record<string, unknown>>;
  /** Tool argument name -> state field whose current value is passed. */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Tool output key -> state field it is written to. */
  readonly output: Readonly<Record<string, string>>;
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
  | ToolNode
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
  /** Edge id chosen at a solo point. */
  readonly next?: string;
}

/** Offline scripted response for an agent node: (state, visit index) -> result. */
export type DemoResponder = (state: Readonly<Record<string, unknown>>, visit: number) => NodeResult;

export interface DemoScript {
  readonly agents?: Readonly<Record<string, DemoResponder>>;
  /** Values the scripted human gives at approval nodes, per visit. */
  /** Raw tool output per tool node (keyed by tool output keys), for offline runs. */
  readonly tools?: Readonly<
    Record<string, (state: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>>
  >;
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

/**
 * A phase: a named group of steps shown as one collapsible node on the canvas
 * ("List evidence", "Deep read"). Purely structural; the engine ignores it.
 */
export interface ScoreGroup {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly nodes: readonly string[];
}

export interface PatternGraph {
  readonly state: readonly StateField[];
  readonly nodes: readonly ScoreNode[];
  readonly edges: readonly ScoreEdge[];
  readonly start: string;
  /** Global step budget. Default 100. */
  readonly maxSteps?: number;
  /** Default model tier for agent nodes. */
  readonly complexity?: Complexity;
  /** Default improvisation level. */
  readonly improvisation?: Improvisation;
  /** Phases: named groups of nodes, collapsed into one node on the canvas. */
  readonly groups?: readonly ScoreGroup[];
  /** State keys the run delivers (shown as its result), e.g. ['answer', 'openQuestions']. */
  readonly result?: readonly string[];
}

export interface Pattern extends PatternGraph {
  readonly name: string;
  readonly description: string;
  readonly verbTriggers?: readonly string[];
  /** State keys the caller must provide through `context` at compile time. */
  readonly requiredContext: readonly string[];
  /**
   * The required input that states the run's goal (e.g. investigate's `question`).
   * When set, the goal is that input's value and no separate goal is asked for.
   */
  readonly goalFrom?: string;
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
  readonly complexity: Complexity;
  readonly improvisation: Improvisation;
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
  /** Independent takes that an integrator merged into this answer (jazz). */
  readonly takes?: readonly AiTranscript[];
  /** Set when the answer was replayed from a recorded performance (classical). */
  readonly fromRepertoire?: string;
  /** Who played: enough to tell whether two answers came from the same musician. */
  readonly musician?: Musician;
}

export interface Musician {
  /** Complexity tier the step asked for. */
  readonly tier: Complexity;
  /** Model the tier (or MODEL) resolved to; the provider's default when absent. */
  readonly requestedModel?: string;
  readonly effort?: string;
  /** Account the provider used, e.g. 'token' or 'signed-in user'. */
  readonly account?: string;
  /** Provider SDK and version, e.g. '@github/copilot-sdk@1.0.6'. */
  readonly sdk?: string;
  /** Sampling settings, or why they are not recorded. */
  readonly sampling: string;
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
  readonly capabilities: readonly Capability[];
  readonly complexity: Complexity;
  readonly improvisation: Improvisation;
  readonly isolated: boolean;
  /** Independent takes to play before integrating (1 = a single take). */
  readonly takes: number;
  /** Present at an active solo point: the routes the AI may choose from. */
  readonly choices?: readonly {
    readonly edgeId: string;
    readonly label: string;
    readonly to: string;
  }[];
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
  readonly shows: readonly string[];
  readonly outputSchema: readonly StateField[];
  readonly feedback?: readonly string[];
  readonly moveKey: string;
}

export interface ToolPause {
  readonly kind: 'tool';
  readonly pauseId: string;
  readonly step: number;
  readonly nodeId: string;
  readonly label: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, string>>;
  readonly outputSchema: readonly StateField[];
  readonly feedback?: readonly string[];
  readonly moveKey: string;
}

/**
 * An AI step used up its attempts. Instead of failing the run, the engine waits
 * for a human: retry it (with a hint, a smarter model) or stop the run.
 */
export interface StuckPause {
  readonly kind: 'stuck';
  readonly pauseId: string;
  readonly step: number;
  readonly nodeId: string;
  readonly label: string;
  /** Why the last attempt was rejected. */
  readonly feedback: readonly string[];
  /** Attempts made so far at this step. */
  readonly attempts: number;
  /** Complexity tier the step was played at. */
  readonly complexity: Complexity;
  readonly moveKey: string;
}

/** A human's decision at a stuck step. */
export interface Recovery {
  readonly action: 'retry' | 'stop';
  /** Added to the AI's feedback on retry. */
  readonly hint?: string;
  /** Play the retry at this tier (e.g. a smarter model). */
  readonly complexity?: Complexity;
  readonly by?: string;
  readonly at?: string;
}

export type Pause = AgentPause | ApprovalPause | ToolPause | StuckPause;

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

export interface ToolResolution {
  readonly kind: 'tool';
  readonly pauseId: string;
  /** State updates (already mapped through the node's `output`). Ignored when `error` is set. */
  readonly updates?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly at?: string;
}

export interface RecoveryResolution extends Recovery {
  readonly kind: 'recovery';
  readonly pauseId: string;
}

export type Resolution =
  | AgentResolution
  | ApprovalResolution
  | ToolResolution
  | RecoveryResolution
  | CancelResolution;

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
      readonly type: 'recovered';
      readonly step: number;
      readonly nodeId: string;
      readonly recovery: Recovery;
    }
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
  /** Edge chosen by the AI at a solo point. */
  readonly next?: string;
  readonly verdict?: MoveVerdict;
  readonly attempts?: readonly {
    readonly errors: readonly string[];
    readonly transcript?: AiTranscript;
    /** The raw rejected answer, so replay can feed it back verbatim. */
    readonly result?: unknown;
    readonly at?: string;
  }[];
  readonly transcript?: AiTranscript;
  readonly approval?: { readonly approved: boolean; readonly by?: string };
  /** Human decisions when the step got stuck (retry with hint or model, or stop). */
  readonly recoveries?: readonly Recovery[];
  readonly at?: string;
}

export interface Performance {
  readonly schemaVersion: 3;
  /** Engine version that played it (ENGINE_VERSION). */
  readonly engine: string;
  /** Who played the AI steps ('scripted' = the offline demo). Absent in older runs. */
  readonly provider?: string;
  /** Set when this performance continued another one from a checkpoint. */
  readonly basedOn?: {
    readonly kind: 'resumed' | 'forked';
    /** Saved run file it continued. */
    readonly from: string;
    /** Steps up to here were replayed from that run; later ones were played live. */
    readonly throughStep: number;
  };
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
  readonly schemaVersion: 3;
  readonly score: ExecutableScore;
  readonly performance: Performance;
}
