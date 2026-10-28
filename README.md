# symphony-core

Deterministic, auditable AI orchestration, plus a visual studio where you can watch the data move.

A **state machine owns order, gates and validation**. AI runs **only inside agent nodes**
(assessor = read-only, executor = read-write). Algorithms are **Patterns written in TypeScript**.
Every run produces a **Performance**: a JSON audit record you can replay and verify byte for byte.

```text
Pattern (TypeScript) ─ compileScore ─▶ ExecutableScore (read-only plan, content-hashed id)
                                         │
                       createEngine + advance (pure reducer, no I/O)
                                         │  pauses only at agent (AI) and approval (human) nodes
                                         ▼
                       Performance (steps, state diffs, AI transcripts, full event log)
```

Think of it as an orchestra. The **maestro** composes the score: it routes the request to a
pattern, judges its **complexity**, and runs a debate sized to that complexity. The **engine** is the
conductor: it makes every musician (AI agent) play exactly the notes of the score, in order. How
much the musicians may **improvise** is one knob, from 🎻 Classical (same song, same notes) to 🥁 Free jazz.

## Quick start (only Node.js needed)

Requires **Node.js 20.19+ or 22.12+** (npm ships with Node). No pnpm, no build step.

```bash
git clone https://github.com/pirty6/symphony-core.git
cd symphony-core
npm install
npm start            # opens the studio at http://localhost:5173
```

Type a request in **🎼 Ask the maestro** and press **Compose & perform**, or pick **hangman** in
the library and press **▶ Run**. Everything works offline: the default
**Scripted (offline demo)** provider answers agent nodes from each pattern's demo script, so you
can explore every feature without credentials.

> pnpm users: `pnpm install && pnpm start` works the same (pnpm stays the primary lockfile).

### Use real AI (GitHub Copilot)

1. Have a GitHub account with Copilot and be signed in (VS Code, the Copilot CLI or `gh auth login`),
   **or** put a token in `.env` (see `.env.example`). If that token is rejected, Symphony says so and
   falls back to your signed-in GitHub user for the rest of the session.
2. In the studio choose **AI → GitHub Copilot** and run. Each agent call uses the model for its
   complexity tier (see below); typing a model in the toolbar forces one model for every tier.

Agents work in the repository folder by default; set `SYMPHONY_WORKSPACE=/path/to/project` in `.env`
to point them at another project. **Executor nodes can edit files and run commands there**;
assessor nodes are held read-only by the permission policy (reads, URLs and read-only shell
commands only).

## The studio

| Area | What it shows |
|------|---------------|
| Canvas | The pattern graph. Patterns with **phases** open collapsed, one node per phase showing the step running inside it; click ⊕ to open a phase or **Open all phases**. Nodes light up as they run (active, waiting, done, failed) with a visit counter. Edges show their guard, the state keys they carry, a moving **data packet** on the edge just taken, and the actual values that travelled on it. Loops route around the side. |
| Toolbar | AI provider, **complexity** (auto or 1-4; hover for the model per tier), the **improvisation knob** (🎻 Classical … 🥁 Free), auto-approve, **step mode**, Run / Pause / Step / Resume / Stop. |
| Inspector | **Gate card** when paused: before a node runs, or *after the AI answered but before the engine applies it* (shows the proposed JSON). **Approval card** for human nodes; at the maestro's go-gate it shows the composed score, the debate notes and the inputs. **AI output** streams the agent's text, model and tier, tool calls, permission denials and submitted result; in jazz, each take and the bandleader's merge. **State** shows every key with what just changed. |
| Result | When a run ends, its result (the last data carried toward the end, e.g. `answer` and `openQuestions`) appears formatted at the top of the inspector. **Read full result** opens a wide reader with Copy and Download .md; long results open it automatically. Esc closes it. |
| Timeline | Every engine event. Scrub back and forth; the canvas and inspector follow. |
| Library | **🎼 Ask the maestro** (it composes the score, you approve, then the studio follows the performance), patterns, a drag-and-drop palette, and **saved runs** (open one to replay it; the studio re-runs the engine on the recorded answers and confirms it reproduces exactly). |

Stop mid-process: **Pause** halts at the next gate, **breakpoints** (the dot on a node) halt
before and after that node, **step mode** halts at every gate, and **Stop** aborts the live AI call
while keeping its partial output visible.

Recover instead of starting over:

| Situation | What happens |
|-----------|--------------|
| An AI step gives no valid answer in all its attempts | The run pauses as **stuck** instead of failing. Read what it tried in **AI output**, then **↻ Retry step**, optionally with a hint for the AI and a smarter tier, for a fresh set of attempts, or **✕ Stop run**. The CLI asks the same in a terminal. Unattended runs (auto-approve, no terminal) stop, as before. Each decision is recorded on the step and replayed exactly. |
| The run was interrupted or stopped | It was saved after every answer: **▶ Resume** (or `cli resume <file>`) continues from there. |
| You want to redo a step that finished | Open the saved run, move the timeline to the step, **⑂ Fork from step N** (or `cli fork <file> --at N`). Earlier steps are kept, the rest plays again. |
| A page or file could not be read (HTTP 429, timeout) | Investigate reports it with a reason instead of failing, tries it once more at the end of deep reading, and lists what still could not be read in the answer's coverage. |

Edit flows visually: drag nodes from the palette, connect handles (conditions have `then`/`else`,
approvals `approved`/`rejected`), edit nodes and edges in the inspector, define state fields in the
Pattern tab. Validation runs on every change and **Run** stays disabled until the graph is valid.
**View TypeScript** / **Save to library** turn the canvas into a TypeScript pattern in
`src/patterns/drafts/`.

## CLI

```bash
npm run cli -- maestro "Fix the flaky login test" --provider copilot   # compose, approve, perform
npm run cli -- maestro "..." --compose-only --save   # only compose; save it as a TypeScript pattern
npm run cli -- run analyze -i swing --complexity 3   # improvisation and complexity per run
npm run cli -- list                                  # pattern library
npm run cli -- show fix                              # nodes and edges
npm run cli -- run hangman                           # play in the terminal
npm run cli -- run fix --auto-approve                # scripted run, saved to .symphony/runs
npm run cli -- run investigate -c question="Where is auth handled?" --provider copilot
npm run cli -- run fix --step --break apply          # pause at gates
npm run cli -- run investigate -c question="Why do logins fail on CI?" --then fix --provider copilot
#   chain: fix starts with what investigate found; inputs for it: -c fix.testCommand="npm test"
npm run cli -- draft "triage a flaky test" --provider copilot --save
npm run cli -- verify .symphony/runs/fix/<file>.json # integrity + deterministic replay check
npm run cli -- compare <a.json> <b.json>             # where two runs diverge, and why
npm run cli -- rehearse analyze -n 5 --provider copilot -i swing   # how deterministic is the AI here?
npm run cli -- resume .symphony/runs/fix/<file>.json # continue an interrupted or stopped run
npm run cli -- fork .symphony/runs/fix/<file>.json --at 4   # keep steps 1-3, play the rest again
npm run cli -- runs                                  # saved runs (in-progress = resumable)
```

## Concepts

### Node kinds

| Kind | Who acts | Purpose |
|------|----------|---------|
| `start` | engine | Entry point (exactly one). |
| `agent` | **AI** | `role: 'assessor'` (read-only) or `'executor'` (read-write). Sees only its `reads`; must return its `writes`. Optional `capabilities` (`web`, `mcp`) and acceptance `checks`. |
| `tool` | runtime | Deterministic I/O, no AI: `repo.files` (every file, with exclusions explained), `sources.catalog` (every evidence source available). The result is recorded and replayed. |
| `compute` | engine | Deterministic state update: `field = expression`. |
| `condition` | engine | Branch on an expression: `then` / `else`. |
| `approval` | human | Gate; the human may provide values (`writes`). `approved` / `rejected` edges. |
| `end` | engine | Finish with `success`, `partial` or `failed`. |

Edges are tried in declared order; the first guard that is `true` wins; one unguarded default edge
may come last.

**Acceptance checks** are expressions evaluated on the state as it would be after the agent's answer.
If any is false the answer is rejected and the agent is re-asked with the check's message. This is
how a pattern forces full coverage instead of trusting the AI:

```ts
checks: [{ expr: 'subset(batch, triaged)', message: 'You skipped files. List EVERY file of batch.' }]
```

**Goal**: every run has one; each AI step sees it as the overall goal, and it names saved runs.
When a required text input already states it (investigate's `question`, fix's `issue`, analyze's
`question`, the maestro's `request`), the pattern sets `goalFrom` to that input and nobody types the
goal twice. Patterns whose inputs are just data (review's `target` branch) ask for a goal.

**Phases** (`groups` on a pattern) name a run of consecutive steps, e.g.
`{ id: 'listPhase', label: 'List evidence', nodes: ['needFiles', 'inventory', …] }`. The engine
ignores them; the studio draws each phase as one node (lit by its busiest step) that you can open
into its steps. A step belongs to at most one phase and the start node to none. Approval nodes can
list state keys in `shows` so the human sees exactly what they approve.

**Capabilities** give an agent node extra sources: `web` adds `web_search` (keyless, DuckDuckGo)
next to Copilot's `web_fetch`; `mcp` connects the MCP servers from your VS Code user `mcp.json` and
the workspace's `.vscode/mcp.json` / `.mcp.json`. Assessors may only call MCP tools marked read-only.
Set `SYMPHONY_MCP=off` to disable MCP or `SYMPHONY_MCP_USER=off` to ignore the VS Code user file.

### Expressions

Guards, conditions and compute nodes use a small, safe language (no `eval`, no coercion):
state keys by name, literals and list literals (`["a", b]`), `== != < <= > >= && || ! + -`,
`len empty includes lower append if chars subset take drop first unique without`, and
`verdict.outcome` / `verdict.confidence` of the last agent.

```ts
'confidence >= 0.7 && len(findings) > 0'
'if(includes(word, letter), wrongCount, wrongCount + 1)'
```

### Guarantees (and where they are enforced)

| Rule | Enforcement |
|------|-------------|
| The state machine owns order | `src/core/engine.ts`: pure `advance()`; AI cannot choose the next node. |
| Score is read-only | `compileScore` deep-freezes it; its id is a content hash (`verifyScore` detects edits). |
| Every AI response is validated | `validateNodeResult`: verdict shape, typed `writes`, no undeclared keys. Invalid answers are re-asked with the errors (bounded `retries`), then the run fails. |
| Never repeat `(moveType, targetSite, stateHash)` | The engine refuses a repeated move; `stateHash` covers run state plus a git workspace fingerprint. |
| Every loop terminates | Per-node `maxVisits` and per-score `maxSteps`. |
| Assessors are read-only | Permission policy in `src/runtime/provider.ts`: reads and URLs allowed; shell only for allowlisted read-only commands (`git diff/log/show/blame`, `gh issue/pr/run/search view\|list`, `gh api` GETs, `grep`, `ls`, ...); loops and conditions (`for`/`while`/`if`) allowed when every command inside them is; MCP only for read-only tools; writes and command substitutions refused, and output may only be redirected to `/dev/null` or another stream. |
| Nothing is skipped | Acceptance checks reject answers that leave out items (files, sources, gaps); the engine, not the AI, owns the work queues. |
| Stale or duplicate input is ignored | Every resolution must echo the open `pauseId`. |
| Runs are reproducible | `replayPerformance` re-runs the engine on recorded answers and diffs it. |
| Hashes never alias | `canonicalJson` refuses NaN, Infinity, `undefined` in arrays, Dates, Maps and class instances instead of collapsing them; state fields must be plain JSON. |
| Runs survive crashes | The run is saved after every answer; `restoreEngine` rebuilds it from those answers (refusing histories that no longer reproduce) so it can be resumed or forked. |
| Old runs stay readable | Runs record the engine version; older formats are upgraded by pure migrations; a diverging replay says if another engine version recorded it. |

### What "deterministic" means here

The **orchestration** is deterministic: same score + same answers = same performance, step for
step, which `verify` proves for any saved run. The **musicians** are not: a live model can answer
differently each time. Symphony makes that boundary explicit instead of hiding it:

| Source of difference | How it is handled |
|----------------------|-------------------|
| The AI | Classical (improvisation 0) replays recorded answers for identical moves. Above that, every step is labelled by who played it (script, recorded answer, live AI, takes) and `rehearse` measures per-node agreement across N live performances. The Copilot SDK exposes no seed or temperature, so each transcript records the tier, requested model, effort, account and SDK version instead. |
| The environment | Tool nodes are the only way the outside world gets in, and their outputs are recorded. The offline demo plays its recorded tool outputs, so it depends only on (pattern, goal, context). |
| The plan | The score id hashes everything that shapes the run. |
| The engine | Recorded with every run (`ENGINE_VERSION`). |

`compare` names the first divergence between two runs and which of these caused it.

## The maestro, complexity and improvisation

### The maestro (meta-algorithm)

`maestro` is itself a pattern run by the same engine, so every decision it makes is recorded and
replayable:

1. **Route** (tools + AI): list the library, match verb triggers deterministically, then the AI
   confirms the pattern (or `new`) and classifies **complexity 1-4**.
2. **Debate**, roster by complexity. All debaters are isolated (no workspace tools): they plan,
   they don't diagnose.

   | Complexity | Debate |
   |---|---|
   | 1 | none if a pattern fits as is (pre-debated); proposer if new |
   | 2 | proposer + skeptic |
   | 3 | proposer + skeptic + pragmatist |
   | 4 | + template-critic, who can reroute to another pattern once |

   Their contracts are enforced, not requested: the pragmatist must triage **every** skeptic concern,
   the critic's verdict must be CORRECT, WRONG or HYBRID and may only recommend real patterns.
3. **Conductor**: folds the debate into one score (applies REAL concerns, ignores THEORETICAL ones).
4. **Validate** (tool): the draft is checked deterministically; errors go back to the proposer
   (max 6 rounds).
5. **Read inputs** from the request, then the **go-gate**: approve with empty feedback to perform;
   write feedback for another round (complexity escalates one tier); reject to stop.
6. **Perform**: the composed score runs as its own linked, recorded run at the final complexity.

### Complexity → model

Each agent call uses the model of its tier, with reasoning effort when the model supports it.
A node may pin its tier; otherwise a state field `complexity` (the maestro's) or the score's is used.

| Tier | Default model (Copilot) |
|---|---|
| 1 routine | `claude-haiku-5.5` (low) |
| 2 some judgement | `claude-sonnet-5` (medium) |
| 3 risky | `claude-sonnet-5.5` (high) |
| 4 novel | `claude-opus-5.5` (xhigh) |

Override with `SYMPHONY_TIERS="1=claude-haiku-4.5,3=gpt-6.1-sol:high"`. Unavailable models fall
back to your default model with a note. `MODEL`/`COPILOT_MODEL` force one model for every tier.

### Classical to jazz: the improvisation knob

| Level | What the musicians may do |
|---|---|
| 0 🎻 Classical | Same song (same score, inputs and workspace) ⇒ **exactly the same notes**: answers recorded for an identical move are replayed from the repertoire (`.symphony/runs`) instead of asking the AI again. Routes are scripted. |
| 1 🎷 Cool | A fresh take every performance; routes still scripted. |
| 2 🎷 Swing | **Solo points**: the AI chooses where the tune goes next among the score's labelled routes. |
| 3 🎺 Bebop | Read-only agents play **2 independent takes**; a bandleader merges them (call and response). |
| 4 🥁 Free | 3 takes, and agents are invited to try unconventional angles. |

Whatever the level, every performance is recorded and replays exactly, executors (which change
the world) always play one take, and a solo can only pick routes the score wrote. The `analyze`
pattern is built for jazz: in classical it runs every budgeted analysis, from Swing the AI decides
when it has enough evidence.

## The investigate pattern

`investigate` answers a question without skipping information. It is built from **phases**, and
the listing adapts to the question: "is this on the internet?", "does this work in this repo?" and
"why is oxlint slower than eslint?" each list different evidence. The engine owns every work queue:

1. **Plan research**: a tool lists the sources available here (the workspace with its file count,
   git history, GitHub if `gh` is signed in, installed dependencies, the web, experiments, each MCP
   server, earlier Symphony runs). The AI splits the question into sub-questions and decides which
   sources apply. Every source must be used or skipped with a reason, or the plan is rejected.
   **Competing hypotheses**: before any evidence is read, an isolated proposer lists at least 3
   distinct explanations (including "none of these"), each with what would confirm or refute it.
   Every later research step looks for evidence for *and against* each one.
2. **List evidence**: only what the plan chose. *Workspace* lists every file (git-aware; binaries,
   lockfiles and files over 512 KB are excluded with the reason). *Web* has the AI search and list
   the pages worth reading. *Experiment* has the AI design the commands to run (benchmarks, timing,
   profiling).
3. **Triage files** (loop): every listed file, in batches of `batchSize` (25). An answer that leaves
   out a file is rejected.
4. **Deep read** (loop): every relevant file *and* every listed page, read completely,
   `deepBatchSize` (4) at a time.
5. **Run experiments**: you approve the commands (the approval card shows them), then each one runs
   with scratch files only and its measurements become findings. Rejecting skips the phase.
6. **Search sources** (loop): each remaining source (git, GitHub, dependencies, MCP…) searched as
   fits; every query is recorded.
7. **Close gaps** (loop): unanswered sub-questions get targeted research (up to `maxGapRounds`),
   then a human hint if confidence stays low.
8. **Answer**: cites evidence and ends with a coverage report: files triaged and excluded, pages
   read, experiments run, sources searched and skipped, what is still unknown. It must give a
   ruling (CONFIRMED, REFUTED or UNKNOWN, with evidence) on every hypothesis.
9. **Challenge the answer**, scaled by complexity:

   | Complexity | Who | Does |
   |-----------|-----|------|
   | 1 | nobody | the answer stands |
   | ≥2 | Skeptic (isolated) | concrete, checkable objections: unsupported claims, hypotheses dismissed without evidence, alternatives the evidence also fits, paths nobody followed |
   | ≥3 | Pragmatist (isolated) | keeps only the REAL objections; theoretical ones don't cost a research round |
   | 4 | Second investigator | answers from scratch without seeing the first answer; a reconciler merges both and lists disagreements |

   Real objections go back to "Close gaps" as research targets, at most `maxDebateRounds` (2)
   times, so the debate always ends.

The debate is a shared building block (`src/patterns/phases/debate.ts`): `hypothesesPhase` and
`challengePhase` return state, nodes, edges and a phase that any pattern can wire in, the same
roster the maestro uses to debate a plan, aimed at a conclusion instead.

```bash
npm run cli -- run investigate -c question="Why do runs replay exactly?" --provider copilot
```

## Use it from VS Code chat and Copilot Studio

Symphony is also an MCP server (`src/mcp-server.ts`) with the same pipeline as tools: `maestro`,
`run_pattern` (with `chain`), `get_run`, `answer_approval`, `answer_stuck`, `stop_run`,
`list_patterns`. Runs go on in the background; the chat polls them and relays every approval and
stuck step to you. Each run is saved and replayable as usual.

### VS Code: `/maestrov2`

```bash
npm install
npm run install:vscode      # once; add -- --insiders for VS Code Insiders, -- --uninstall to remove
```

This installs, for every workspace:
- the `/maestrov2` prompt and the `maestro-v2` agent, in your user prompts folder;
- the `symphony` MCP server, in your user `mcp.json`. Your other servers and comments are kept,
  and a `.bak` copy is written.

VS Code starts the server whenever the agent needs it, so there is nothing to keep running. Reload
the window, then type `/maestrov2 find out why login fails on CI, then fix it` in Chat. It works
on the folder you have open (the workspace root VS Code reports), and the AI runs on your signed-in
Copilot account.

### Copilot Studio

Copilot Studio runs in the cloud and connects to MCP servers over **Streamable HTTP**, so it needs
a URL that reaches the server. To use your machine through a VS Code dev tunnel:

```bash
export SYMPHONY_MCP_KEY=$(openssl rand -hex 24)   # keep it: Copilot Studio needs it
export SYMPHONY_WORKSPACE=/path/to/your/repo      # the folder pipelines work in
npm run mcp:http                                  # http://127.0.0.1:8787/mcp

brew install --cask devtunnel                     # once (Windows: winget install Microsoft.devtunnel)
devtunnel user login
devtunnel host -p 8787 --allow-anonymous          # prints https://<id>-8787.<region>.devtunnels.ms
```

The tunnel lets Copilot Studio through; Symphony's API key protects `/mcp`, and `/health` is open
so you can check the URL. Then, in Copilot Studio:
1. Open your agent: **Tools**, **Add a tool**, **New tool**, **Model Context Protocol**.
2. Name `Symphony`; server URL `https://<id>-8787.<region>.devtunnels.ms/mcp`.
3. Authentication **API key**, in a **header** named `x-api-key`; create the connection with your
   `SYMPHONY_MCP_KEY`.
4. Paste [integrations/copilot-studio/instructions.md](integrations/copilot-studio/instructions.md)
   into the agent's instructions.

Remote callers are read-only. Patterns that edit files and run tests (fix, refactor) are refused,
and other executor steps (investigate's experiments) play with read-only permissions. To allow
edits on the host, set `SYMPHONY_ALLOW_EDITS=1`. Symphony's own server is never offered to its AI
steps, so pipelines don't nest.

## Fix and refactor

Both patterns end with the same shared **edit and verify** phase
(`src/patterns/phases/editVerify.ts`): the executor edits; the **engine** captures the diff
(`git.diff`) and runs the tests, and the lint command if you give one (`tests.run`). "Tests
passed" is a fact, never the AI's report. The test command is a run input (`testCommand`) or the
project's own test script; the AI never chooses it. Output is normalized so identical results
hash identically. A failure is triaged before retrying:

| Triage | Then |
|--------|------|
| PATCH: the edit is wrong or incomplete | edit again with the failure (up to `maxAttempts`, 3) |
| DIAGNOSIS: the plan or root cause is wrong | fix goes back to research with the failure (up to `maxDiagnoses`, 1) and you approve the new plan |
| ENVIRONMENT: flaky, missing dependency, failing before the change | stop: another edit cannot fix it |
| No progress: the edit changed nothing, or repeats the last attempt | caught before the tests run again: re-diagnose, or stop |

- **fix** = investigate's diagnosis + edit and verify: competing hypotheses, evidence for and
  against each, a diagnosis that must name files and rule on every hypothesis, the skeptic and
  pragmatist (by complexity), then your approval, showing root cause, rulings, files and plan.
- **refactor** = a green baseline + a plan + edit and verify. It will not start on red tests;
  the plan lists the behaviour that must not change and the tests that prove it; bugs noticed on
  the way go to `noticedBugs` instead of being fixed (that would change behaviour).

**Chaining**: one pattern's result feeds the next pattern's goal input (`core/chain.ts`):
`--then` in the CLI, **Then run** in the studio, or the maestro when a request asks for two shapes
("find out why X, then fix it"). Each run is still its own score and performance.

## Library API

```ts
import { compileScore, createEngine, advance, toPerformance, fix, Run, ScriptedProvider } from '@perezgarciam/symphony-core';

// Low level: drive the pure engine yourself.
// fix has goalFrom: 'issue', so the issue is the goal; other patterns take { goal: '...' }.
const score = compileScore(fix, { context: { issue: 'Page 2 repeats an item' } });
let { state } = createEngine(score);
while (state.kind === 'running' && state.pause) {
  const res = await answer(state.pause);               // your AI / human / test double
  ({ state } = advance(score, state, res));
}
const performance = toPerformance(state);

// High level: the driver with providers, gates and persistence.
const run = new Run({ score, provider: ScriptedProvider.forPattern(fix), demo: fix.demo, autoApprove: true });
run.subscribe((m) => console.log(m));
await run.start();
```

Write a pattern as a TypeScript module (see `src/patterns/*.ts`) and add it to
`src/patterns/index.ts`, or save it from the studio into `src/patterns/drafts/` (loaded automatically).

## Project layout

```text
src/core/        pure, browser-safe: types, expr, schema, validate, compile, engine, graph, replay, draft, hash
src/runtime/     I/O: providers (scripted, Copilot), run driver, drafting loop, store, factory
src/patterns/    the pattern library (TypeScript), including maestro; drafts/ for saved patterns
src/cli.ts       command line
packages/ui/     the studio: Vite + React Flow; server/api.ts mounts REST + SSE on the dev server
```

## Development

```bash
npm test             # core + runtime + CLI (vitest)
npm run test:ui      # studio unit + integration + API tests
npm run typecheck && npm run lint
npm run build        # library to dist/
cd packages/ui && npx playwright install chromium && npx playwright test   # browser e2e
```

See [AGENTS.md](AGENTS.md) for the rules contributors (human or AI) follow.

## License

ISC
