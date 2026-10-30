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

1. Sign in once with a GitHub account that has Copilot:

   ```bash
   npm run login     # opens GitHub in the browser (or shows a code); nothing else to install
   ```

   Already signed in to the GitHub CLI (`gh auth login`) or the Copilot CLI? That is used as is.
   On a machine without a browser, put `COPILOT_GITHUB_TOKEN=<token>` in `.env` instead: a
   **fine-grained** personal access token with the **Copilot Requests** permission (classic tokens
   are not accepted). If nothing is signed in, the studio says so as soon as you choose Copilot,
   and a run stops at once with these instructions instead of failing step by step.
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
| Library | **🎼 Ask the maestro** (it composes the score, you approve, then the studio follows the performance), patterns, a drag-and-drop palette, and **saved runs** (open one to replay it; the studio re-runs the engine on the recorded answers and confirms it reproduces exactly). Offline-demo runs are hidden behind **Show N offline-demo runs**, so the list holds your real runs. **Running now** lists every run the server is playing; click one to switch to it (its stream replays from the start). |

Stop mid-process: **Pause** halts at the next gate, **breakpoints** (the dot on a node) halt
before and after that node, **step mode** halts at every gate, and **Stop** aborts the live AI call
while keeping its partial output visible.

Recover instead of starting over:

| Situation | What happens |
|-----------|--------------|
| An AI step gives no valid answer in all its attempts | The run pauses as **stuck** instead of failing. Read what it tried in **AI output**, then **↻ Retry step**, optionally with a hint for the AI and a smarter tier, for a fresh set of attempts, or **✕ Stop run**. The CLI asks the same in a terminal. Unattended runs (auto-approve, no terminal) stop, as before. Each decision is recorded on the step and replayed exactly. |
| The AI provider blocks an answer (content filtering) | The same model blocks the same prompt every time, so retrying it cannot help: the provider asks the nearest tiers' other models (up to two) and records which ones blocked (`musician.blockedOn`). If all of them block, the step's error says so ("the AI provider blocked the response…") instead of a shape error; retry at another tier or with a hint. A run saved mid-step keeps the step's rejected attempts, with what the AI said, in `performance.pending`. |
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
npm run cli -- run backlog -c source=docs/improvements.md --provider copilot   # one implement run per picked item
npm run cli -- draft "triage a flaky test" --provider copilot --save
npm run cli -- verify .symphony/runs/fix/<file>.json # integrity + deterministic replay check
npm run cli -- compare <a.json> <b.json>             # where two runs diverge, and why
npm run cli -- rehearse analyze -n 5 --provider copilot -i swing   # how deterministic is the AI here?
npm run cli -- rehearse maestro -n 5 --provider copilot -c "request=..." --fields chosen,complexity  # does routing agree?
npm run cli -- resume .symphony/runs/fix/<file>.json # continue an interrupted or stopped run
npm run cli -- fork .symphony/runs/fix/<file>.json --at 4   # keep steps 1-3, play the rest again
npm run cli -- runs [--all]                          # saved runs (in-progress = resumable); --all adds demo runs
npm run cli -- runs --prune [--dry-run]              # delete old demo runs, compact old runs (see Cleaning up)
npm run cli -- eval [--task a,b] [-n 3] [--compare <report.json>]   # tasks with known answers (see Quality, cost and speed)
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
`len empty includes lower append if chars subset take drop first unique without pick join`, and
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
| Assessors are read-only | Permission policy in `src/runtime/provider.ts`: reads and URLs allowed; shell only for allowlisted read-only commands (`git diff/log/show/blame`, `gh issue/pr/run/search view\|list`, `gh api` GETs, `grep`, `ls`, ...); loops and conditions (`for`/`while`/`if`) allowed when every command inside them is; MCP only for read-only tools; command substitutions (`$(…)`, backticks) only when every command inside them is read-only; `NAME=value` alone, or before `echo`/`printf`/`test`; writes refused, and output may only be redirected to `/dev/null` or another stream. |
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

   A complexity you choose (`--complexity 1-4` in the CLI, the toolbar in the studio, `complexity`
   over MCP) wins over the classifier's rating, which is kept as `ratedComplexity`: you control
   the cost tier on every surface. The go-gate remains the backstop if you under-rate a request.

   Their contracts are enforced, not requested: the pragmatist must triage **every** skeptic concern,
   the critic's verdict must be CORRECT, WRONG or HYBRID and may only recommend real patterns.

   **Library patterns are adapted, not rewritten.** The debate reads a compact outline of the chosen
   pattern (6-7x smaller than its definition) and writes an `adaptation`: guidance appended to
   specific AI steps (`directives`) and new values for its settings (`initial`: loop bounds, batch
   sizes, flags like `exhaustive`). The engine applies it to the tested pattern, whose steps, edges
   and checks stay as they are. Rewriting the whole pattern cost up to 138k output tokens and 15-24
   minutes per run, and sometimes silently dropped tested steps. A full draft is still written for
   `new` patterns, or when the shape truly has to change (the proposer must say why).
3. **Conductor**: folds the debate into one score (applies REAL concerns, ignores THEORETICAL ones).
   Skipped when the skeptic found nothing to change (below tier 4).
4. **Validate** (tool): the adaptation applied to the template (or the draft) is checked
   deterministically; errors go back to the conductor (revise) to fix, without a new debate
   (max 6 rounds).
5. **Read inputs** from the request (one line per input, not the whole score), then the **go-gate**,
   which shows how the pattern was tailored: approve with empty feedback to perform;
   write feedback for another round, at the same complexity unless you tick `smarter` (one tier up:
   a deeper debate on a stronger model); reject to stop. Feedback after
   the last round (`maxRounds`, 6) is never dropped: the run ends partial without performing,
   keeping the score and your feedback (`unappliedFeedback`, also in the debate notes).
6. **Perform**: the composed score runs as its own linked, recorded run at the final complexity.
   The goal stays your verbatim request. When the pattern takes a `hint` (fix, implement,
   investigate, refactor), the debate's open doubts and any uncovered requirement are handed over
   there as a short brief, after your own hint.

**Requirement ledger: substance, not only form.** The classifier lists the request's explicit
requirements, and every piece of go-gate feedback is appended (`requirements`), so later rounds must
still meet it instead of reading it once. The debaters read the ledger (the conductor may not drop
a step that meets one), and a **Check requirements** step maps each requirement to the step that
meets it (`coverage`: "R2: baseline — runs the tests first", or NOT COVERED). Uncovered ones go
back to the proposer while rounds remain; after that they are shown at the go-gate, which shows
the mapping in the studio and over MCP. The `maestro-requirements` eval task judges it by code:
every requirement maps to a step that exists in the approved score, and a requirement about
tests maps to a step that is about tests. (One entry per requirement is still partly a form check;
the go-gate remains the backstop.)

**Memory of compositions.** What you approve at the go-gate is remembered in the workspace's
`.symphony/memory.json`: the request, the pattern, complexity, then-pattern and its adaptation (or
the whole pattern for new ones), with a fingerprint of the library pattern it adapted.

- **The same request again** (ignoring case and spacing), on an unchanged pattern, skips
  classification and the debate: the approved composition is validated and shown at the go-gate,
  marked as reused. Feedback there composes it afresh; if the pattern changed meanwhile, the old
  adaptation goes to the proposer with what no longer fits.
- **Similar requests** get the three closest approved compositions as precedent for the classifier
  and the proposer, so a familiar kind of request usually composes in one round.

### Complexity → model

Each agent call uses the model of its tier, with reasoning effort when the model supports it.

**Where the run's complexity comes from.** If you choose one (toolbar, `--complexity`, or the
maestro's classification), it is used. Otherwise it is **auto** (`complexity = 0`): the
hypotheses proposer of investigate, fix and implement rates the problem 1-4 with a rubric
(1 = one obvious place, 2 = a few places and some judgement, 3 = cross-cutting, ambiguous or needs
experiments, 4 = novel or high-stakes), and an `applyRating` step sets it
(`src/patterns/phases/complexity.ts`). So a harder question gets a bigger model *and* a deeper
debate (skeptic at ≥2, pragmatist at ≥3, second investigator at 4). Steps before the rating, and
patterns without one (refactor, review, analyze), play at tier 2.

**Per step.** A node may pin its tier (`complexity`) or shift the run's tier (`complexityShift`,
-3..3, clamped to 1-4): triage and listing play one tier cheaper, answers, diagnoses, designs and
debaters one tier smarter.

| Tier | Default model (Copilot) |
|---|---|
| 1 routine | `claude-haiku-5.5` (low) |
| 2 some judgement | `claude-sonnet-5` (medium) |
| 3 risky | `claude-sonnet-5.5` (high) |
| 4 novel | `claude-opus-5.5` (xhigh) |

Override with `SYMPHONY_TIERS="1=claude-haiku-4.5,3=gpt-6.1-sol:high"`. Unavailable models fall
back to your default model with a note. `MODEL`/`COPILOT_MODEL` force one model for every tier
(leave them unset to use the tiers).

### Tokens and prompt size

Copilot reports token usage per call; each AI transcript records it (`usage`), and the CLI, the
studio's summary line and the MCP `get_run` show the run's total (calls, input, output, cached).
Answers replayed from the repertoire cost 0. Prompts send each step only what it `reads`: the goal
is not repeated when it is one of the inputs, context keys already in the input are dropped, and
loops read only what is new (investigate's deep reads don't resend every earlier finding). Prompt
wording is not part of a move's identity, so trimming never breaks Classical replay.

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
   lockfiles and files over 512 KB are excluded with the reason). A repository with more than
   `maxTriageFiles` (300) files is not triaged file by file: a **Locate** step searches it first
   (`git grep` for the names and errors in the question, `git log`/`git show` for the commits and
   PRs it mentions, then imports, callers and tests one level out) and lists at most 300 files, each
   with why; the engine rejects any path that is not a real file of the repository. Only those are
   triaged, and the coverage says the rest were not. Pass `-c exhaustive=true` to triage every file. *Web* has the AI search and list
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
   **Several subjects** ("how can A, B and C be improved", "compare X, Y and Z"): the plan lists
   them in `parts` (2 to 8). Evidence is still gathered once for all of them; then **Answer each
   part** plays one call per subject at the same time (at most 4), each on its own subject, and the
   answer becomes a summary across them. The skeptic and reconciler see the parts too, and the
   engine attaches every part after the summary at the end. This is cheaper than one investigation
   per subject (evidence gathering is about 90% of an investigation's cost, measured on recent runs)
   and keeps what the subjects share in one place.
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

Runs are saved to `.symphony/runs`, or to `SYMPHONY_RUNS_DIR` when it is set. The test suites
point it at a temporary folder, so their runs never reach your lists.

### Several runs at once

One server (the studio, or the MCP server behind `/maestrov2` and Copilot Studio) plays any number
of runs at the same time, each with its own state, saved file and scratch folder. In the studio,
start another run while one is waiting and switch between them under **Running now**.

Runs that edit files (fix, refactor, implement) with a real AI each play in their **own git
worktree** (`src/runtime/worktree.ts`), so two of them never see each other's edits or test
results:

1. The worktree starts from a snapshot of your workspace as it is: `HEAD` plus your uncommitted
   and untracked files, with `node_modules` (and `.venv`) linked so the tests run as they do for
   you. The snapshot is committed only inside the worktree, so the run's diff shows its own edits.
2. When the run ends, its edits come back as one patch. They are **applied to your workspace** if
   the run succeeded and the patch applies cleanly; otherwise (it failed, was stopped, or you
   changed the same lines meanwhile) the patch is kept in `.symphony/patches/` and the result
   says `git apply <patch>`. The worktree is then removed.
3. The result card, the CLI and `get_run` say where the edits went (`Performance.edits`).

`SYMPHONY_WORKTREES=off` makes editing runs work in your workspace directly (one at a time, as
before); `SYMPHONY_KEEP_WORKTREE=1` keeps the worktree for debugging. Outside a git repository
runs edit the workspace directly. A resumed editing run starts again from your workspace as it is.

### Cleaning up

- **Scratch**: each real run gets its own `.symphony/scratch/<run>` folder; executors are told to
  put temporary scripts and output there, and it is deleted when the run ends (success, failure or
  stop). `SYMPHONY_KEEP_SCRATCH=1` keeps it for debugging.
- **Retention**, once a day by itself (`SYMPHONY_RETENTION=off` disables it), or on demand with
  `npm run cli -- runs --prune [--dry-run]` or the 🧹 button next to Saved runs:

  | What | When | Then |
  |------|------|------|
  | Offline-demo runs | older than 7 days | deleted |
  | Real runs | older than 30 days | **compacted**: events, per-step changes and inputs, and the AI's prompt and output text are dropped; every answer, hash, decision, who answered and token usage are kept. Only if the run still replays exactly; opening it rebuilds its timeline by replay. |
  | Scratch folders left by a crashed run | older than 1 day | deleted |

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
- the `/maestrov2` prompt and the `maestro-v2` agent, in your user prompts folder (Copilot Chat);
- the `maestrov2` skill, in `~/.agents/skills/maestrov2`, for chats that load skills rather than
  prompt files (Copilot CLI, the VS Code agent host). Same instructions as the agent;
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

Remote callers are read-only. Patterns that edit files and run tests (fix, refactor, implement) are refused,
and other executor steps (investigate's experiments) play with read-only permissions. To allow
edits on the host, set `SYMPHONY_ALLOW_EDITS=1`. Symphony's own server is never offered to its AI
steps, so pipelines don't nest.

## Fix, refactor and implement

All three end with the same shared **edit and verify** phase
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
- **implement** = a green baseline + competing approaches (including "it already exists") +
  evidence from the code + a **design with acceptance criteria** and the tests that will prove
  them, which the skeptic attacks and you approve + **tests first** (below) + edit and verify (a
  wrong design goes back to exploring) + an **acceptance review**: passing tests are not enough; every criterion must be MET
  with evidence (a test or the code in the diff), and unmet ones go back to editing up to
  `maxReviews` (2) times, else the run ends partial.

```bash
npm run cli -- run implement -c request="Add a --json flag to the list command" --provider copilot
```

**Tests first** (implement, `src/patterns/phases/testFirst.ts`): the tests are written before the
code, so they cannot be fitted to the implementation, and the engine proves they test something:

1. The executor writes only the tests in `testsToAdd`; the engine checks (git diff) that the step
   changed nothing but the files it listed in `testFiles`.
2. The engine runs the tests: the suite must fail. Tests that pass before any code check nothing new.
3. An assessor checks each criterion fails for the right reason (the behaviour is missing, not a
   syntax error or a broken test): `RED`, or `GUARD` for "existing behaviour stays the same", which
   should pass already. Anything else goes back with the reasons, up to `maxRedAttempts` (2), then
   you decide whether to implement anyway.
4. The engine hashes `testFiles` (locked). The executor makes them pass by changing the code; after
   every green run the hash must still match, or you decide whether the changed tests are acceptable.

**PR review** (`src/patterns/phases/prReview.ts`): once the tests pass (and, for implement,
every acceptance criterion is met), a reviewer on another model family reads the diff like a pull
request. Blocking comments (`BLOCKING path:line — what and why`) go back to the edit step, the
engine re-runs the tests, and the review runs again until it approves. After `maxReviewRounds`
(2) you decide: accept the change as it is (the comments stay in the result) or stop.

**Chaining**: one pattern's result feeds the next pattern's goal input (`core/chain.ts`):
`--then` in the CLI, **Then run** in the studio, or the maestro when a request asks for two shapes
("find out why X, then fix it"). Each run is still its own score and performance.

**Backlog**: turn a document of improvements (or a pasted investigate result) into one run per
item (`src/patterns/backlog.ts`). An assessor reads `source` (a workspace file or the text
itself) and writes at most 10 self-contained requests, skipping what the code already does; you
pick the item numbers (`1, 3`; empty = all; reject = none). The runtime then plays `runPattern`
(`implement` by default, or `fix` / `refactor`) once per pick, in order, each in its own run with
its own worktree, approvals and PR review; `testCommand` goes to every item. A failed item does not
stop the rest (a plain chain does); stopping a run stops them all. The CLI ends with a table of how
each item went; the studio follows each run as it starts.

```bash
npm run cli -- run backlog -c source=docs/improvements.md -c testCommand="npm test" --provider copilot
```

## Optional patterns: metaphor to model

Optional patterns live in `src/patterns/extras/` and are not part of the core library. Turn them on
with `SYMPHONY_EXTRAS` (names, comma-separated, or `all`); the studio tags them `extra`:

```bash
SYMPHONY_EXTRAS=metaphor,storm-in-between npm start
SYMPHONY_EXTRAS=all npm run cli -- list
```

`metaphor` (`src/patterns/extras/metaphor.ts`) turns a metaphor into a pattern you can run. It reads the
metaphor's frames, tensions, movements and what must stay true, then maps it to a model by fixed
rules (`METAPHOR_RULES`), so any metaphor maps the same way:

| Part of the metaphor | Becomes |
|---|---|
| a voice or perspective | an agent node writing its own field |
| a tension (A vs B) | a condition, or a loop between them with a bound |
| a pulse, listening over time | a loop with a round counter |
| a filter | agent checks or a condition |
| coexistence | a compute node that keeps every field |
| ground, stillness | an early step that reads the input |
| feeling, judgement | an approval |
| resolution | end nodes; `result` lists every voice |

The AI drafts the pattern, the engine validates it (errors go back to the draft, up to 3 rounds),
you approve it or write feedback for another draft, and the engine saves it to
`src/patterns/drafts/<name>.ts`, where the studio and the CLI list it. Built-in names are never
overwritten. `src/patterns/extras/storm-in-between.ts` is an example: a storm read as an edge, a
center, a filter, a forecast and the beat between them.

```bash
SYMPHONY_EXTRAS=all npm run cli -- run metaphor -c metaphor="Chaos is a storm..." -c name=my-storm --provider copilot
SYMPHONY_EXTRAS=all npm run cli -- run storm-in-between -c subject="this week's sales data" --provider copilot
```

## Quality, cost and speed

Every change here was measured with `symphony eval` and kept only if it did not lower the
solved rate or citation validity.

- **`symphony eval`** (`src/eval/`): small fixture repos with a known right answer: two fixes, an
  implement and a refactor checked by hidden tests the AI never saw, and an investigate whose
  docs say 8080 while the code says 8081. It records solved, citations valid, tokens, time and
  models, saves each run, and `--compare` flags (exit 2) a run worse than its baseline on
  correctness. `--task routing` adds 20 maestro requests (compose only) judged in code on the
  pattern chosen, a complexity band and the chained pattern; `rehearse maestro --fields
  chosen,complexity` measures how often routing agrees with itself.
- **Checked evidence.** Findings are written `path:line — fact \`quote\``. A **Check citations**
  step (`evidence.check`) after every research step keeps only findings whose file, line and
  quote are real (the rest go to `unverified`); the Copilot provider also sends wrong citations
  back in-session while the AI still has the files open (`cites`). Recorded findings get ids
  (F1, F2…) and answers, root causes and designs must cite existing ids (`refs`, `ids`).
- **The step's own checks run in-session** too ("at least 3 hypotheses"), so a bad answer is fixed
  while the AI still has its context instead of costing a fresh attempt.
- **Malformed answers are repaired before they are judged.** Claude models sometimes send
  `updates` as text: the whole result with its `{"updates":` cut off (sometimes its last `}` too),
  an object never closed with its other fields sent beside it, trailing commas, a `verdict` inside
  `updates`, or tool-call markup (`<parameter name="…">`). Each shape is repaired deterministically
  and then checked like any answer; on 150 recorded payloads, 115 now pass instead of 0 (the rest
  lack a verdict or fields, and are sent back for a correction). Rejected attempts cost up to 48%
  of a maestro run before; the CLI and `eval` report them (`rejected: N attempts …`).
- **The last valid answer wins, but an empty one never replaces one with content**: a skeptic's
  eight real concerns were once lost to an empty second call. The AI is told, and the run notes it.
- **Parallel parts (`fanOut`).** investigate's triage and deep reads take a wave of four batches
  (100 files to triage, 16 items to read in full) and play them at once (at most 4 calls); answers are checked per part and merged in part order,
  so the result does not depend on timing and replays exactly.
- **Memory across runs** (`.symphony/memory.json`). Facts that passed the citation check are
  remembered; a **Recall earlier runs** step brings back those that share words with the question
  *and still match the files today* (re-checked at recall), plus lessons from earlier fix and
  implement runs. They are leads to check, never evidence. The store stays clean: run tags such
  as `[H2 against]` are stripped, only the newest fact per `path:line` is kept, one run writes at
  most 200 facts (so a few runs cannot replace the whole store), lessons expire after 90 days or
  when their files are gone, and recall weights rare words above common ones.
- **Replays know who played.** A recorded answer is reused only for the same move *and* the same
  model settings (tier, requested model, effort); `compare` names "played by different models"
  as a cause instead of calling two runs identical.
- **Low confidence is re-checked** (`verifyBelow`, 0.6 on answers, diagnoses and designs): once,
  one tier smarter. **Second opinions use another model family** (`otherModel`; set
  `SYMPHONY_ALT_MODEL`, default `gpt-6.1-sol`).
- **Prompts**: what is fixed for a step comes first and the changing input last, so repeat visits
  reuse the model's prompt cache; steps with no workspace tools get a short system prompt instead
  of the SDK's (~4k tokens fewer per call); every step is anchored to the overall goal.
- **Time limit per step** (15 min, `SYMPHONY_STEP_TIMEOUT_S`): a hung call is retried, then waits
  for a human like any stuck step. Mechanical steps already play a tier lower (smaller model,
  lower reasoning effort) through `complexityShift`.
- **Compact JSON in prompts.** Inputs are sent unindented: about 3-4% fewer prompt characters
  (measured on 549 recorded Copilot prompts), less than the 1.5x a pretty-printing estimate
  suggests, because most of a prompt's JSON is long strings.

**Decided, and left alone (until the eval says otherwise):**

- **Debate depth.** Raising the debate thresholds saved 16% of prompt characters but its effect
  on quality is unknown, and the maestro's confidences are not calibrated enough to gate on.
  It stays as is until `eval --task routing` and `maestro-requirements` can measure it.
- **The goal is the verbatim request.** Every step reads it; the debate's open doubts travel in
  `hint` instead (see the maestro's Perform step).
- **Debate history does not pile up**: each debater reads the current draft and the latest
  critique, not a transcript, so there is nothing to summarise. The lossy point was rejected
  answers, now repaired before they are judged.
- **`runs --prune`** (`compact.ts`) only deals with old saved runs, not with prompt context.
- **Drift in the composed score** is what the requirement ledger addresses.
- **Past compositions for the classifier** are the composition memory: only approved ones are
  stored, and they are precedent, not a cache.

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
