# Offline trials for investigate's read pipeline

Each trial is an A/B run with the eval harness on the same fixture. It changes one setting, with
`--with key=value` (a pattern input) or a `SYMPHONY_*` trial switch (an env var), and compares
the result with a baseline report. The report's first line names what each side was played
with. `--compare` exits 2 when the trial is worse than its baseline: fewer solved, more invalid
citations, 25% more input tokens per run, 50% more time per run, a step's cached share down 15
points, or a step whose input grows more over its visits.

Live trials call Copilot and spend premium requests. `investigate-many-files` (240 files,
several waves) is the main fixture: it is heavy and runs only when named. Use `-n 3` or more,
because runs vary and there is no seed. The report then shows the spread.

```sh
# The baseline, once: defaults. Its path is printed as "saved .symphony/evals/<stamp>.json".
npm run cli -- eval --task investigate-many-files -n 3
BASE=.symphony/evals/<stamp>.json
```

Every report records per run:
- tokens, the cached share, premium requests, time, and model time per step;
- citations checked and valid;
- findings, and sub-questions answered (`evidence`);
- why answers were rejected (`rejection reasons`);
- rate limits hit (`rate limits`);
- the read record's share of the saved run (`read record`).

Each run is saved next to the report (`<stamp>-runs/`), to open in the studio or replay.

## 1. Six vs four parallel sub-agents: wall time and HTTP 429s

The plan chooses `agents` (at most 6). `agentsCap` caps that choice, and the saved score keeps
`fanOut.agents` on every fanned-out step (a test checks this).

```sh
npm run cli -- eval --task investigate-many-files -n 3 --with agentsCap=4 --compare $BASE
```

Compare: `time`, `slowest steps` (triage, deepRead) and `rate limits: N model calls`.

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
npm run cli -- eval --task investigate-many-files -n 3 --with singlePass=true --compare $BASE
```

Compare: tokens, time, solved, and how many files skipped the deep read. A file skips it only
when the engine's record shows triage was given that file whole.

## 4. Rejection reasons, then automatic fixes and delta repair

First, read `rejection reasons` in the baseline report: each step and reason, with how often it
happened. Automatic fixes should target the most frequent reasons. Then measure delta repair:
after a rejected `submit_result`, the AI resends only the fields it changes.

```sh
SYMPHONY_DELTA_REPAIR=1 npm run cli -- eval --task investigate-many-files -n 3 --compare $BASE
```

Compare: `rejected N attempts`, its premium requests, output tokens and solved.

## 5. Caching with the header in the system message, and how Copilot bills cached tokens

`SYMPHONY_HEADER_IN_SYSTEM=1` sends each step's fixed instructions as the system message and
only its input as the prompt.

```sh
SYMPHONY_HEADER_IN_SYSTEM=1 npm run cli -- eval --task investigate-many-files -n 3 --compare $BASE
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
}' .symphony/evals/<stamp>-runs
```

Fit `nanoAiu` against uncached input, cached input and output across calls. The cached
coefficient is what a cached token costs relative to an uncached one.

## 6. Sonnet vs Opus on the deep read, same question

`SYMPHONY_NODE_MODELS` plays the named steps on their own model; every other step keeps its tier.

```sh
SYMPHONY_NODE_MODELS=deepRead=claude-sonnet-5.5 npm run cli -- eval --task investigate-many-files -n 3
SYMPHONY_NODE_MODELS=deepRead=claude-opus-5.5 npm run cli -- eval --task investigate-many-files -n 3 --compare .symphony/evals/<sonnet>.json
```

Compare: solved, `evidence`, `citations valid`, and the deep read's tokens and time
(`costliest steps`, `slowest steps`).

## 7. deepBatchSize 4 vs larger

```sh
npm run cli -- eval --task investigate-many-files -n 3 --with deepBatchSize=8 --compare $BASE
```

Compare: tokens (more files share one prompt prefix), time, `growing context` and solved.

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
npm run cli -- eval --task investigate-planted-flaw,investigate-false-premise,investigate-multi-hop -n 3 --with maxDebateRounds=1 --compare .symphony/evals/<two-rounds>.json
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

## Waiting on these trials

- Hypotheses block: trim it only after an A/B. `--with readerHypotheses=false` is the ablation.
- singlePass: enable by default only after trial 3.
- Delta repair: enable by default only after trial 4.
- The narrowed read (`narrowRead`) is opt-in for good. Files that are neither matched by the
  search nor among the next `narrowBudget` (20) are never read, and the coverage names each
  one. In one recorded run, files ranked 90–150 were still 57% relevant.
