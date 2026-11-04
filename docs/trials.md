# Offline trials for investigate's read pipeline

Each trial is an A/B run with the eval harness on the same fixture. It changes one setting, with
`--with key=value` (a pattern input) or a `SYMPHONY_*` trial switch (an env var), and compares
the result with a baseline report. The report's first line names what each side was played
with. `--compare` exits 2 when the trial is worse than its baseline: fewer solved, more invalid
citations, 25% more input tokens per run, 50% more time per run (and at least 10 s more), a step's cached share down 15
points, or a step whose input grows more over its visits.

Live trials call Copilot and spend premium requests. `investigate-many-files` (240 files,
several waves) is the main fixture: it is heavy and runs only when named. Use `-n 3` or more,
because runs vary and there is no seed. The report then shows the spread.

```sh
# The baseline, once: defaults. Its path is printed as "saved <evals>/<stamp>.json".
npm run cli -- eval --task investigate-many-files -n 3
BASE=$(npm run -s cli -- where evals)/<stamp>.json
```

Every report records per run:
- tokens, the cached share, premium requests, time, and model time per step;
- citations checked and valid;
- findings, and sub-questions answered (`evidence`);
- why answers were rejected (`rejection reasons`);
- rate limits hit (`rate limits`);
- the read record's share of the saved run (`read record`).

Each run is saved next to the report (`<stamp>-runs/`), to open in the studio or replay. `<evals>`
is `symphony where evals`, outside the repository.

## 1. Six vs four parallel sub-agents: wall time and HTTP 429s

The plan chooses `agents` (at most 6). `agentsCap` caps that choice, and the saved score keeps
`fanOut.agents` on every fanned-out step (a test checks this).

```sh
npm run cli -- eval --task investigate-many-files -n 3 --with agentsCap=4 --compare $BASE
```

Compare: `time`, `slowest steps` (triage, deepRead) and `rate limits: N model calls`, and also
`evidence` and each step's input. The cap is not only concurrency: it sets the wave sizes, and
`leadStatus` (the hypothesis tally that steers later readers) is refreshed once per wave. A
different cap can therefore change what later readers are told, not only how many run at once.

## 2. Gap-aimed vs current research

`gapAimed` makes the gap research work on what the gap check says is missing (its `S<n>: GAP —
…` notes) instead of the whole sub-question.

```sh
npm run cli -- eval --task investigate-many-files,investigate-multi-hop -n 3 --with gapAimed=true --compare $BASE
```

Compare: `evidence` (findings, sub-questions answered), `citations valid` (the verified share)
and `tokens`. With `--compare`, use a baseline played on the same tasks.

## 3. singlePass A/B

```sh
npm run cli -- eval --task investigate-many-files,investigate-multi-hop,investigate-history -n 3
npm run cli -- eval --task investigate-many-files,investigate-multi-hop,investigate-history -n 3 --with singlePass=true --compare <evals>/<off>.json
```

Compare: tokens, time, solved, and how many files skipped the deep read. A file skips it only
when the engine's record shows triage was given that file whole. The engine checks only that
the single-pass reader was given the file whole and wrote a note per file. Whether it followed
callers, imports, tests and history rests on the reader:
- `investigate-multi-hop`'s answer is two imports away from the question.
- `investigate-history`'s reason is only in a commit message.

So these two tasks are the ones that can show what singlePass loses.

A cheaper single-pass reader is a separate trial: target its node id. Trial 6 targets `deepRead`,
which does not play with singlePass on.

```sh
SYMPHONY_NODE_MODELS=triageDeep=claude-sonnet-5 npm run cli -- eval --task investigate-multi-hop,investigate-history -n 3 --with singlePass=true --compare <evals>/<singlePass>.json
```

## 4. Rejection reasons, then automatic fixes and delta repair

First, read `rejection reasons` in the baseline report: each step and reason, with how often it
happened. Automatic fixes should target the most frequent reasons. Then measure delta repair:
after a rejected `submit_result`, the AI resends only the fields it changes. It is on by default;
the trial is the run with it off.

```sh
SYMPHONY_DELTA_REPAIR=0 npm run cli -- eval --task investigate-many-files -n 3 --compare $BASE
```

Compare: `rejected N attempts`, its premium requests, output tokens and solved.

## 5. Caching with the header in the system message, and how Copilot bills cached tokens

`SYMPHONY_HEADER_IN_SYSTEM` (on by default) sends each step's fixed instructions as the system
message and only its input as the prompt. The trial is the run with it off.

```sh
SYMPHONY_HEADER_IN_SYSTEM=0 npm run cli -- eval --task investigate-many-files -n 3 --compare $BASE
```

Compare: `first-call cache` (the cached share of each step's first calls) and the cache-share
regressions `--compare` flags. To see how cached tokens are billed, list each call's tokens and
the nano AI units Copilot reported for it, from the saved runs:

```sh
node -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1];
console.log("step\tinput\tcached\toutput\tnanoAiu");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  for (const s of run.performance.steps)
    for (const t of [s.transcript, ...(s.transcript?.parts ?? [])])
      for (const c of t?.calls ?? [])
        if (c.nanoAiu) console.log([s.nodeId, c.inputTokens, c.cacheReadTokens, c.outputTokens, c.nanoAiu].join("\t"));
}' <evals>/<stamp>-runs
```

Fit `nanoAiu` against uncached input, cached input and output across calls. The cached
coefficient is what a cached token costs relative to an uncached one.

## 6. Sonnet vs Opus on the deep read, same question

`SYMPHONY_NODE_MODELS` plays the named steps on their own model; every other step keeps its tier.

```sh
SYMPHONY_NODE_MODELS=deepRead=claude-sonnet-5.5 npm run cli -- eval --task investigate-many-files -n 3
SYMPHONY_NODE_MODELS=deepRead=claude-opus-5.5 npm run cli -- eval --task investigate-many-files -n 3 --compare <evals>/<sonnet>.json
```

Compare: solved, `evidence`, `citations valid`, and the deep read's tokens and time
(`costliest steps`, `slowest steps`).

## 7. deepBatchSize 4 vs larger

```sh
npm run cli -- eval --task investigate-many-files -n 3 --with deepBatchSize=8 --compare $BASE
```

Compare: tokens (more files share one prompt prefix), time, `growing context`, solved and
`evidence`. A larger batch also makes the waves larger (deepBatchSize × agents × 3), so fewer
items get the evidence an earlier wave adds to `leadStatus`. It can also replace parallel calls
with fewer, longer ones, so fewer calls do not mean faster. Include a multi-wave task
(`investigate-many-files`) and a small one (`investigate-multi-hop`).

## 8. The overhead of recording output per range

The deep read writes one note per item (`readNotes`), and the engine records what it gave each
step (`preloaded`). The report's `read record` line gives their share of the saved run's
characters. Their cost in output tokens is about the notes' characters divided by 4. Compare
that with the deep read's output tokens in `costliest steps`.

## 9. One debate round vs two, on known answers

The debate is the only thing that catches the planted flaw: compare the cap at the same
complexity.

```sh
npm run cli -- eval --task investigate-planted-flaw,investigate-false-premise,investigate-multi-hop -n 3
npm run cli -- eval --task investigate-planted-flaw,investigate-false-premise,investigate-multi-hop -n 3 --with maxDebateRounds=1 --compare <evals>/<two-rounds>.json
```

Compare: solved, `citations valid`, tokens and time. Round 2 cost ~16% of input and ~21% of
time in one recorded run; this says whether it pays.

## 10. Calibrating the support judge (shadow)

`investigate-misread-quote` has a real quote attached to a wrong claim, and its `-judged` twin
plays the judge in `enforce`. Run the pair, then the other investigate tasks with the judge in
`shadow`, so that false rejections on correct findings show up.

```sh
npm run cli -- eval --task investigate-misread-quote,investigate-misread-quote-judged -n 3
npm run cli -- eval --task investigate-default-port,investigate-multi-hop,investigate-false-hint -n 3 --with supportJudge=shadow --compare $BASE
```

Compare: whether the judged twin is solved and the plain one is not (recall), what shadow marks
unsupported on tasks whose findings are right (false rejections), and the judge's tokens
(`judgeSupport` in `costliest steps`).

## 11. One sub-agent per gap vs one call for all gaps

```sh
npm run cli -- eval --task investigate-many-files,investigate-multi-hop -n 3 --with gapsPerChase=1 --compare $BASE
```

Compare: the `chase` time and tokens (`symphony cost` on the saved runs). The earlier "at most
~4% of time" was an estimate that subtracted the largest possible warm-up, not a measurement.

## 12. Lower research caps vs the defaults

A tailoring once lowered `maxChaseRounds` to 4 and `maxDebateRounds` to 1. Did the answers get
worse?

```sh
npm run cli -- eval --task investigate-many-files,investigate-multi-hop,investigate-planted-flaw -n 3 --with maxChaseRounds=4 --with maxDebateRounds=1 --compare $BASE
```

## Per-step shares of a saved run

`npm run cli -- cost <run.json> [more.json]` prints each step's share of input tokens and AI
time, with fan-out parts and rejected answers counted. Use it on the runs each trial saves
(`<stamp>-runs/`), not on shares taken from an investigation's own analysis.

It also prints:
- **Model time by call.** Each model call is tagged with the `submit_result` calls it made, so
  its time is split into these phases:
  - `work`: reading before any answer.
  - `answer`: the call that submitted.
  - `correction`: after a rejected answer, until one is recorded.
  - `revision`: a new answer after one was recorded.
  - `closing`: the reply to "stop now".
  - `blocked`: a call on a model whose content filter blocked the reply, before another model answered.

  Runs recorded before the tagging show `untagged`.
- **In-session corrections.** Engine attempts never count these. `get_run`'s `usage` shows
  them too (`modelTime`, `inSessionCorrections`).
- **Waits for a person, apart.** Each approval records when it was asked and, over MCP, when
  `get_run` first showed it. The wait therefore splits into client polling (`shown after`) and
  the person deciding (`decided in`).

## 13. Maestro under five minutes: closing calls and the debate's effort

Composing at tier 3 already fits in five minutes, review included. At tier 4, model time alone
was 325–408 s. Two levers remained. Both are now defaults, after the results below.

**End the session at the answer** (`SYMPHONY_END_ON_SUBMIT`, on by default since this trial;
`=0` turns it off). The session ends
when the model turn that made a valid `submit_result` ends. Without the setting, the model
answers "stop now" with one more call (4–6 s per step). Parallel submissions in that turn still
count. A revision in a later turn is lost, and saved runs show the AI does revise after an
accepted answer (for example "I also corrected three part answers"). So read `revision` in
`cost` on the baseline first.

```sh
TASKS=maestro-requirements,maestro-planted-concern
npm run cli -- eval --task $TASKS -n 3
BASE=<evals>/<that-stamp>.json
SYMPHONY_END_ON_SUBMIT=1 npm run cli -- eval --task $TASKS -n 3 --compare $BASE
```

**A lower effort on the tier-4 debate.** The pragmatist marks concerns THEORETICAL, and the
conductor then ignores them. Only the triage count is checked in code, so a cheaper debater
could downgrade a real concern without any test noticing. `maestro-planted-concern` (tier 4,
heavy) checks for exactly this. Its request asks for the closed form `n*(n+1)/2`, which breaks
the documented cases `n < 1` and fractions. It passes only when the composed score runs the
tests and deals with those cases. `maestro-planted-concern-tier3` is the same request without
the critic.

A node model scopes the cut to the maestro's own steps; the composed run keeps its tiers.
`step=model:effort` sets the effort. Without an effort, the step keeps its tier's effort, and
the effort that was sent is recorded under `musician`.

```sh
npm run cli -- eval --task maestro-planted-concern -n 3
SYMPHONY_NODE_MODELS=propose=claude-opus-5.5:high,skeptic=claude-opus-5.5:high,pragmatist=claude-opus-5.5:high \
  npm run cli -- eval --task maestro-planted-concern -n 3 --compare <evals>/<baseline>.json
```

**Results (2026-11-04, live, n=3 per task).**

| | `maestro-requirements` | `maestro-planted-concern` (tier 4) | Whole report |
|---|---|---|---|
| Baseline | 3/3 solved, 33–41 s, 46–52k in | 3/3, 240–259 s, 99–106k in, 24–26k out | 82 premium requests. Closing calls: 39 of 82 calls, 140 s (17% of model time). 1 revision (cover) in 39 steps |
| `SYMPHONY_END_ON_SUBMIT=1` | 3/3, 23–30 s, 21–29k in | 3/3, 230–250 s, 44–61k in, 23–25k out | 45 premium requests (−45%), input −51%, no closing calls, 3 in-session corrections |
| Debate on `opus:high` (propose, skeptic, pragmatist) | — | 3/3, 146–155 s, 86–89k in, 14–15k out | Still has closing calls: 107 s (25% of model time) |

The planted concern was caught in every run. Ending at the answer saves premium requests and
input tokens. Wall time drops only on short runs, because long ones are dominated by the
skeptic's and the pragmatist's reasoning. Lowering the debate's effort cuts the tier-4
composition by ~39% (≈246 s → 150 s). Both results come from small fixtures, so confirm them on a
real request before relying on them.

Both are now on by default. `SYMPHONY_END_ON_SUBMIT=0` turns the first off. The maestro's
propose, skeptic and pragmatist set `maxEffort: 'high'`, and `SYMPHONY_EFFORT_CAPS=0` plays each
tier's own effort again. To re-run the trial against the new defaults, the baseline is now the
run with those switches at `=0`.

Read: solved on the planted concern (it must not drop), time per run, and `model time by call`
for the debate steps. Recorded replays are keyed on model and effort, so they will not match
across the two runs. Do not use `--complexity 3` or `complexityShift` for this trial: they also
change the child run, or tier 3.

## Warm start off: time for tokens

Gap research and part answers start one sub-agent first, so the others reuse its cached prompt
(`warmFirst`). Turning it off can save up to ~30 s per step, and costs the cache reuse.

```sh
npm run cli -- eval --task investigate-many-files -n 3 --with warmFirst=false --compare $BASE
```

Compare: time, tokens and `first-call cache` (the cached share of each step's first calls).

## Improvisation: quality, not only cost

At improvisation 3 and above, non-fanned-out assessor steps (the skeptic among them) get 2–3
independent takes and an integrator call. That multiplies their calls. It is also a second look
that can find evidence or raise an objection the first take missed. So lowering it is not free:
compare solved and `evidence` on the debate's known-answer tasks, not only tokens.

```sh
npm run cli -- eval --task investigate-planted-flaw,investigate-false-premise,investigate-multi-hop -n 3 --improvisation 2
npm run cli -- eval --task investigate-planted-flaw,investigate-false-premise,investigate-multi-hop -n 3 --improvisation 3 --compare <evals>/<at-2>.json
```

## Waiting on these trials

- Hypotheses block: trim it only after an A/B. `--with readerHypotheses=false` is the ablation.
- singlePass: enable by default only after trial 3.
- Delta repair and the header in the system message are on by default; trials 4 and 5 now
  measure them off (`=0`), to turn them off if they make things worse.
- `lean` (investigate, on by default): run the lean A/B below; turn it off if it loses answers.
- The narrowed read (`narrowRead`) is opt-in for good. Files that are neither matched by the
  search nor among the next `narrowBudget` (20) are never read, and the coverage names each
  one. In one recorded run, files ranked 90–150 were still 57% relevant.
- The stability gate (fix): `autoStabilityRuns` stays 0 until the flaky trial below.

## Flaky tests: does fix stop a false "Fixed"?

`fix-flaky` is a test that fails about 1 run in 4. Its hidden check replays every answer order,
so a lucky green, a retry or a skipped test does not pass it, and a success that is not a real
fix is noted `FALSE FIXED`. `fix-flaky-gated` is the same task with the stability gate armed.

```sh
npm run cli -- eval --task fix-flaky -n 5
npm run cli -- eval --task fix-flaky-gated -n 5
```

Count three things across the runs: false Fixed, real fixes certified, and real fixes stopped as
not certified (a false alarm).

First live results (Copilot, 2026-11-03, 3 runs each):
- **`fix-flaky`:** 3/3 real fixes, about 2 minutes each, and no false Fixed.
- **`fix-flaky-gated`, first try:** 0/3. All three were real fixes that passed the control and
  49 gate runs, but they were stopped by masking flags on the regression test the edit had added
  next to the flaky one (in its file, with a sleep to order the answers).
- **Why it was not simply allowed:** a retry or a sleep added in the flaky test's own file looks
  the same, so that file is still flagged. The edit is now told to put the regression test in a
  new file, and new files are shown in the diff.
- **`fix-flaky-gated`, again:** 3/3 certified. Each put its test in a new file
  (`test/search-order.test.js`). The control saw the test fail by run 2, 5 or 8, then 49 clean
  runs, with no flags; about 2 to 3 minutes each.

This fixture's model fixes it either way. The gate's worth shows only on a model or fixture that
produces a lucky green; the masking fixtures below are that test. Also record:
- **Cost.** The gate's runs and time: control plus `maxStableRuns` per patch.
- **The diagnosis.** Did it set `nondeterministic`, `flakyTarget` (exactly as the runner prints
  it) and `fixTarget`? Nothing else arms `autoStabilityRuns` before the edit.
- **Sizing.** `stabilityTolerance` 0.1 against 0.25 (49 against 18 runs at 8 patches). Pick it
  from how many runs CI makes per push.
- **The command.** On this repository's own flakes, the condition that shows them (load, shuffle,
  the whole suite) and whether the control fails within `maxControlRuns`. Never fewer workers:
  that hides the flake. vitest's results cache, shared across worktrees, reorders files by the
  last run, so consecutive runs are not independent.
- **Masking fixtures.** Plant retries, timeouts, skips, a raised slack constant and fewer
  workers. Measure how often each reaches certified without a person; the unit tests cover the
  flags, but not a live model's edits.

Defaults change behaviour only through fix's prompts: implement and refactor are byte-identical,
and their fingerprints are compared in the PR. Check fix's ordinary tasks with `-n 3`
(`fix-off-by-one`, `fix-wrong-index`, `fix-cause-elsewhere`) before and after, with `--compare`.

Routing: the routing tasks include a named flaky request, a symptom-only one (no trigger word)
and an explain-only one (investigate). Every routing eval so far ran scripted; run
`eval --task routing` on a live model.

## Lean investigate: on vs off

`lean` bundles the settings estimated to cut time and tokens together. It is on by default, so
the trial is whether turning it off answers better. Pin the complexity: most tasks are rated by
the AI, and a run rated lower than 3 would not exercise the debate or the answer's tier. The
gate compares task by task, so losing one safeguard task while gaining another counts as worse.

```sh
TASKS=investigate-many-files,investigate-multi-hop,investigate-history,investigate-planted-flaw,investigate-false-premise
npm run cli -- eval --task $TASKS -n 3 --complexity 3 --with lean=false
BASE=.symphony/evals/<that-stamp>.json
npm run cli -- eval --task $TASKS -n 3 --complexity 3 --compare $BASE
```

Read:
- **Correctness.** Each task, solved as often as with lean off. Invalid citations, as a count
  and as a share.
- **Time.** `investigate-many-files` time per run, against the 15-minute target. The gate only
  checks for 1.5× slower.
- **Where the time went.** `slowest steps`, `first-call cache`, and rejected attempts on
  `answer`.
- **Models.** The effective model and effort per step in the saved runs: a missing model falls
  back silently.

Also open: the answer's first call has stopped at 32,000 output tokens without submitting, and
been resubmitted twice (32–36% of each answer visit). The cap is not set in this repository.

