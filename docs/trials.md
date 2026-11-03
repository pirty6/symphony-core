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
npm run cli -- eval --task investigate-many-files,investigate-multi-hop,investigate-history -n 3 --with singlePass=true --compare .symphony/evals/<off>.json
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
SYMPHONY_NODE_MODELS=triageDeep=claude-sonnet-5 npm run cli -- eval --task investigate-multi-hop,investigate-history -n 3 --with singlePass=true --compare .symphony/evals/<singlePass>.json
```

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
npm run cli -- eval --task investigate-planted-flaw,investigate-false-premise,investigate-multi-hop -n 3 --improvisation 3 --compare .symphony/evals/<at-2>.json
```

## Waiting on these trials

- Hypotheses block: trim it only after an A/B. `--with readerHypotheses=false` is the ablation.
- singlePass: enable by default only after trial 3.
- Delta repair: enable by default only after trial 4.
- The narrowed read (`narrowRead`) is opt-in for good. Files that are neither matched by the
  search nor among the next `narrowBudget` (20) are never read, and the coverage names each
  one. In one recorded run, files ranked 90–150 were still 57% relevant.
