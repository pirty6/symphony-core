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

## Quick start (only Node.js needed)

Requires **Node.js 20.19+ or 22.12+** (npm ships with Node). No pnpm, no build step.

```bash
git clone https://github.com/pirty6/symphony-core.git
cd symphony-core
npm install
npm start            # opens the studio at http://localhost:5173
```

Pick **hangman** in the library and press **▶ Run**. Everything works offline: the default
**Scripted (offline demo)** provider answers agent nodes from each pattern's demo script, so you
can explore every feature without credentials.

> pnpm users: `pnpm install && pnpm start` works the same (pnpm stays the primary lockfile).

### Use real AI (GitHub Copilot)

1. Have a GitHub account with Copilot and be signed in (VS Code, the Copilot CLI or `gh auth login`),
   **or** put a token in `.env` (see `.env.example`). If that token is rejected, Symphony says so and
   falls back to your signed-in GitHub user for the rest of the session.
2. In the studio choose **AI → GitHub Copilot** (optionally a model) and run.

Agents work in the repository folder by default; set `SYMPHONY_WORKSPACE=/path/to/project` in `.env`
to point them at another project. **Executor nodes can edit files and run commands there**;
assessor nodes are held read-only by the permission policy (reads, URLs and read-only shell
commands only).

## The studio

| Area | What it shows |
|------|---------------|
| Canvas | The pattern graph. Nodes light up as they run (active, waiting, done, failed) with a visit counter. Edges show their guard, the state keys they carry, a moving **data packet** on the edge just taken, and the actual values that travelled on it. Loops route around the side. |
| Toolbar | AI provider, auto-approve, **step mode**, Run / Pause / Step / Resume / Stop. |
| Inspector | **Gate card** when paused: before a node runs, or *after the AI answered but before the engine applies it* (shows the proposed JSON). **Approval card** for human nodes. **AI output** streams the agent's text, tool calls, permission denials and submitted result. **State** shows every key with what just changed. |
| Timeline | Every engine event. Scrub back and forth; the canvas and inspector follow. |
| Library | Patterns, **Draft with AI** (describe a flow, the AI drafts a validated pattern onto the canvas), a drag-and-drop palette, and **saved runs** (open one to replay it; the studio re-runs the engine on the recorded answers and confirms it reproduces exactly). |

Stop mid-process: **Pause** halts at the next gate, **breakpoints** (the dot on a node) halt
before and after that node, **step mode** halts at every gate, and **Stop** aborts the live AI call
while keeping its partial output visible.

Edit flows visually: drag nodes from the palette, connect handles (conditions have `then`/`else`,
approvals `approved`/`rejected`), edit nodes and edges in the inspector, define state fields in the
Pattern tab. Validation runs on every change and **Run** stays disabled until the graph is valid.
**View TypeScript** / **Save to library** turn the canvas into a TypeScript pattern in
`src/patterns/drafts/`.

## CLI

```bash
npm run cli -- list                                  # pattern library
npm run cli -- show fix                              # nodes and edges
npm run cli -- run hangman                           # play in the terminal
npm run cli -- run fix --auto-approve                # scripted run, saved to .symphony/runs
npm run cli -- run investigate -c question="Where is auth handled?" --provider copilot
npm run cli -- run fix --step --break apply          # pause at gates
npm run cli -- draft "triage a flaky test" --provider copilot --save
npm run cli -- verify .symphony/runs/fix/<file>.json # integrity + deterministic replay check
npm run cli -- runs                                  # saved runs
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
| Assessors are read-only | Permission policy in `src/runtime/provider.ts`: reads and URLs allowed; shell only for allowlisted read-only commands (`git diff/log/show/blame`, `gh issue/pr/run/search view\|list`, `gh api` GETs, `grep`, `ls`, ...); MCP only for read-only tools; writes, substitutions and redirections refused. |
| Nothing is skipped | Acceptance checks reject answers that leave out items (files, sources, gaps); the engine, not the AI, owns the work queues. |
| Stale or duplicate input is ignored | Every resolution must echo the open `pauseId`. |
| Runs are reproducible | `replayPerformance` re-runs the engine on recorded answers and diffs it. |

## The investigate pattern

`investigate` answers a question without skipping information. The engine owns every work queue:

1. **List sources** (tool): git history, GitHub issues/PRs/CI (if `gh` is signed in), installed
   dependencies, the web, each MCP server, and earlier Symphony runs.
2. **List every file** (tool): the whole workspace, git-aware; binaries, lockfiles and files over
   512 KB are excluded and listed with the reason.
3. **Plan** (AI): split the question into sub-questions and pick the best sources. Every source must
   be used or skipped with a reason, or the plan is rejected.
4. **Triage** (AI, loop): every file, in batches of `batchSize` (25). An answer that leaves out a
   file is rejected.
5. **Deep read** (AI, loop): every relevant file read completely, following imports, callers, tests
   and `git blame`, `deepBatchSize` (4) at a time.
6. **Search sources** (AI, loop): each chosen source searched with web search, `gh`, MCP or git, as
   fits; every query is recorded.
7. **Gaps** (AI, loop): unanswered sub-questions get targeted research (up to `maxGapRounds`), then
   a human hint if confidence stays low.
8. **Answer** (AI): cites evidence and ends with a coverage report: files triaged and excluded,
   sources searched and skipped, what is still unknown.

```bash
npm run cli -- run investigate -c question="Why do runs replay exactly?" --provider copilot
```

## Library API

```ts
import { compileScore, createEngine, advance, toPerformance, fix, Run, ScriptedProvider } from '@perezgarciam/symphony-core';

// Low level: drive the pure engine yourself.
const score = compileScore(fix, { goal: 'Fix pagination', context: { issue: 'Page 2 repeats an item' } });
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
src/patterns/    the pattern library (TypeScript); drafts/ for patterns saved from the studio
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
