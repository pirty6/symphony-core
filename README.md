# symphony-core

Deterministic, auditable AI agent orchestration framework.

Symphony decomposes a problem into a static frequency spectrum and plans a path through it using an orchestra of instrument-typed sub-agents. The result is a **Score** (the plan) and a **Performance** (the recording of what happened).

## Core Concepts

### Stage (Pattern)

A reusable algorithm template. Each Pattern defines:

- **Beats** — ordered steps with a directive, abstraction level (1-8), and instrument
- **Required context** — repo-specific keys the compiler validates
- **Domain** — categorization key

```ts
import { type Pattern } from "symphony-core";

const investigatePattern: Pattern = {
  score: {
    pattern: "investigate",
    domain: "general/investigation",
    beats: [
      { step: "clarify", level: 6, instrument: "question", directive: "Restate the problem..." },
      { step: "scope",   level: 4, instrument: "analyze",  directive: "Identify boundaries..." },
      { step: "search",  level: 2, instrument: "analyze",  directive: "Read the relevant code..." },
      { step: "synthesize", level: 5, instrument: "integrate", directive: "Combine findings..." },
    ],
  },
  description: "Open-ended investigation of a codebase question",
  requiredContext: ["target"],
};
```

### Instruments

Five epistemic modes (not tools) that constrain the kind of cognitive work at each beat:

| Instrument | Mode |
|------------|------|
| `analyze`  | Structural / relational |
| `decide`   | Assertive / definitive |
| `question` | Exploratory / questioning |
| `order`    | Sequencing / timing |
| `integrate`| Harmonic / integrative |

### Exits (MoveVerdict)

After each beat, execution produces a verdict:

```ts
interface MoveVerdict {
  outcome: "applied" | "failed" | "skipped";
  confidence: number;      // [0, 1]
  shouldTerminate: boolean; // halt remaining beats?
  reason: string;
}
```

### Orchestrator

A pure state machine that drives the workflow through six pause kinds:

1. **confirm-fit** — Is this the right pattern?
2. **classify-complexity** — How complex is this problem? (1-4)
3. **draft-pattern-round** — Design a new pattern (up to 6 rounds)
4. **elicit-context** — Collect required context values
5. **go-gate** — Final approval before execution
6. **perform-beat** — Execute each beat

## Usage

### 1. Define a Pattern (Stage)

```ts
import { type Pattern } from "symphony-core";

const myPattern: Pattern = {
  score: {
    pattern: "my-workflow",
    domain: "my-domain",
    beats: [
      { step: "analyze", level: 3, instrument: "analyze", directive: "Examine the target..." },
      { step: "decide",  level: 5, instrument: "decide",  directive: "Choose the approach..." },
      { step: "apply",   level: 2, instrument: "order",   directive: "Execute the changes..." },
    ],
  },
  description: "My custom workflow",
  requiredContext: ["target"],
};
```

### 2. Compile to an ExecutableScore

```ts
import { compileScore } from "symphony-core";

const score = compileScore(myPattern, {
  problem: "Refactor the auth module",
  context: { target: "src/auth" },
});
```

### 3. Execute with the Orchestrator

```ts
import { createEngine, advance, type Resolution } from "symphony-core";

// Start the engine
let state = createEngine({
  prompt: "Refactor the auth module",
  pattern: "my-workflow",
  patterns: [myPattern],
});

// Drive the state machine by resolving each pause
while (state.kind === "running") {
  const pause = state.pause;
  // Build a resolution based on pause.kind
  const resolution: Resolution = /* ... */;
  state = advance(state, resolution);
}

if (state.kind === "done") {
  console.log("Score:", state.result.executableScore);
  console.log("Performance:", state.result.performance);
}
```

### 4. Or execute directly with performScore

```ts
import { performScore, type BeatExecutorContext } from "symphony-core";

const performance = await performScore(score, async (ctx: BeatExecutorContext) => {
  // Your agent logic here — read ctx.beat.directive, produce output
  return {
    voices: [{ instrument: ctx.beat.voices[0].instrument, output: "result...", confidence: 0.9 }],
    verdict: { outcome: "applied", confidence: 0.9, shouldTerminate: false, reason: "Done" },
  };
});
```

## Architecture

```
Pattern (Stage)           →  compileScore()  →  ExecutableScore (Score)
                                                        ↓
                                                 performScore() or
                                                 createEngine() + advance()
                                                        ↓
                                                 Performance (Recording)
```

**Score ≠ Performance** — The Score is the read-only plan. The Performance is what actually happened. This separation enables deterministic replay and auditing.

## API Reference

### Types
- `Level` — 1-8 abstraction scale
- `InstrumentType` — `"analyze" | "decide" | "question" | "order" | "integrate"`
- `Pattern` / `PatternBeat` / `PatternScore` — Stage definitions
- `ExecutableScore` / `Beat` / `Voice` — Compiled plan
- `Performance` / `PerformedBeat` / `PerformedVoice` — Execution recording
- `MoveVerdict` — Beat outcome (exits)

### Functions
- `compileScore(pattern, args)` — Pattern → ExecutableScore
- `parseAlgorithm(input)` — Low-level Score creation
- `performScore(score, executor)` — Async callback-based execution
- `scaffoldPerformance(score)` — Empty Performance scaffold
- `createEngine(config)` — Start the orchestrator state machine
- `advance(state, resolution)` — Advance the state machine
- `validateScoreShape(score)` — Validate a Score
- `fingerprintProblem(statement)` — Hash a problem statement
- `detectDivergence(saved, fresh)` — Compare two Performances

### Legality
- `pairLegality(level, instrument)` — Check if a (level, instrument) pair is legal
- `beatLegality(level, voices)` — Check if a beat configuration is legal
- `isLegalBeat(level, voices)` — Boolean convenience check

## License

ISC

## TODO

### Global Settings Panel
A configuration panel separate from the canvas for orchestrator-level settings:
- **Confidence threshold** — minimum confidence percentage (0–100) before the orchestrator auto-proceeds vs. falls back to human clarification
- **Max assessor spawns** — upper limit on how many assessors the orchestrator can spawn per step based on complexity
- **Retry policy** — max retries per node, backoff strategy when a step fails or returns low confidence
- **Model selection** — which LLM model to use for orchestration (e.g. claude-opus-4.6, gpt-4o, etc.)

### State/Context Model
A typed object that flows through edges and persists across the workflow execution:
- Each node reads from and writes to a shared context bag
- Context is scoped per session (survives across loop iterations)
- Schema is user-definable per workflow (e.g. `{ word: string, guessedLetters: string[], wrongGuesses: string[], maxTries: number }`)
- Enables the orchestrator to maintain memory across multiple LLM calls within the same session

### Node Configuration Panel
Clicking a node opens a side panel to configure that step:
- **Instruction/prompt** — what this step should accomplish (the directive for the LLM)
- **Expected output schema** — what data this step produces so downstream nodes know what they receive
- **Node-specific settings** — e.g. condition expressions for If nodes, approval message for Approval nodes

### Edge Data
Edges carry context from one node's output to the next node's input:
- Define which fields from the source node's output map to the target node's input
- Support data transformation/filtering between nodes
- Visual indication of what data flows through each connection

### Runtime Engine
The backend that actually executes the workflow graph:
- Walks the graph node by node, calling the LLM at each step with accumulated context
- Orchestrator logic at every transition: spawn assessors, check confidence, handle clarification
- Manages the If node branching (evaluate conditions against current context)
- Handles Approval nodes (pause execution, wait for human input, resume)
- Supports loops (detect cycles, carry state across iterations)
- Produces a Performance recording for auditing and replay

### Hook Wiring
`onUserPromptSubmitted` currently returns the prompt unchanged ([src/hooks/onUserPromptSubmitted.ts](src/hooks/onUserPromptSubmitted.ts)). It should:
- Match the incoming prompt against available patterns
- Compile the matched pattern into an ExecutableScore
- Start the engine state machine (`createEngine` → `advance` loop)
- Route pause resolutions back through the copilot-sdk conversation

### Instrument Ontology Reconciliation
The two instrument models (role-based and epistemic) are not competing — they operate at different layers:

```
Canvas layer (UI):      assessor / executor / condition / approval / end
                        ↓ what the user draws
Beat layer (runtime):   analyze / decide / question / order / integrate
                        ↓ what the orchestrator decomposes each node into
Tool layer (agent):     read-only / read-write
                        ↓ what the agent is allowed to do
```

- The **user draws** an assessor or executor node on the canvas and writes a prompt (e.g. "investigate the auth module for vulnerabilities")
- The **orchestrator decomposes** that node into beats, each with an epistemic instrument: `analyze` (structural scan) → `question` (explore edge cases) → `integrate` (synthesize findings). Each beat gets legality constraints based on its abstraction level
- Each beat runs with **tool permissions** inherited from the parent node type: assessor nodes → read-only tools, executor nodes → read-write tools

This keeps the UI simple (2 agent types users understand), gives the runtime fine-grained deterministic control (5 instruments with legality rules), and makes tool permissions enforceable. Users never see the epistemic layer unless they inspect a Performance recording at the beat level.
