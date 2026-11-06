# investigate's settings: what each one trades, and what backs it

Defaults are the `initial` values of investigate's state fields (`src/patterns/investigate.ts`,
`src/patterns/phases/debate.ts`). You change them:
- in the studio, under **Features**, for the nine studio switches;
- per run, with `-c key=value` or `eval --with key=value`;
- per request, through the maestro's tailoring.

A setting with a declared range ("(at least 1)", "(1 to 6)" in the maestro's outline) refuses
values outside it, wherever they come from.

**Evidence tiers:**
- **M:** measured on this repo's recorded runs.
- **D:** a documented design choice, with no numbers behind it.
- **R:** reasoning only.

None of the defaults was set by a controlled A/B. Those trials are planned, with commands, in
[trials.md](trials.md). Measure a run's cost and time per step with `npm run cli -- cost
<run.json>` (fan-out parts and rejected answers included).

## Where a run's cost and time go (M)

These figures come from `symphony cost` on the largest recorded run (4f853, 72.6M input tokens):
- **Input tokens:**
  - the deep read takes 48% of them;
  - gap research (`chase`) takes 20%;
  - the per-part answers take 9%;
  - triage takes 6%.
- **AI time:**
  - the answer takes 21%;
  - the deep read takes 20%;
  - `chase` takes 16%;
  - the per-part answers take 12%.

Shares differ between runs and questions, so treat any single percentage as approximate.

Reading (triage, deep read and gap research) is most of the cost. The answer is a large share of
time but a small share of tokens. Earlier analyses that put the answer at 30–38% of time
undercounted the steps with sub-agents: fan-out steps recorded before they kept their own clock
had counted zero time. Wall time now falls back to the first part's start and the last part's
end.

## Settings

| Setting (default) | Trades | Change it when | Tier |
|---|---|---|---|
| `lean` (on) | One switch for the settings below that cut time and tokens together: `singlePass`, `gapAimed`, `keepUnchallenged`, `gapsPerChase` 1, and an AI-rated complexity 4 capped at 3 (the maestro's rating included; one you set stays). While it is on, those switches cannot be turned back individually | Off if answers get worse, or for a high-stakes run that wants the second investigator. Off, each setting applies as set | R: estimated ≈36–38 min and ≈19.6M input against 55.7 min and 26.0M on one 197-file run (with the two switches below), not yet A/B'd |
| `SYMPHONY_SCRUB` (on; `=off` turns it off) | Credentials in inputs, patterns, AI answers, tool results, transcripts, the live feed, the studio's stream and the CLI's output are replaced by `[REDACTED:<kind>]` before anything is saved or shown | Off only to debug a repair against the raw text, on a machine you trust | D (core/scrub.ts) |
| `SYMPHONY_END_ON_SUBMIT` (on; `=0` turns it off) | Ends a step's session when the turn with a valid answer ends: no closing call (4–6 s per step; closing calls were 15–19% of model time in recorded maestro runs). A revision the AI would have made in a later turn is lost | `=0` if answers that the AI used to revise come out worse (`revision` in `symphony cost`) |
| `SYMPHONY_EFFORT_CAPS` (on; `=0` turns it off) | Steps play at most their `maxEffort`. The maestro's propose, skeptic and pragmatist cap at `high`, which matters only at tier 4 (opus `xhigh`): about 246 s → 150 s per composition, and output −40% | `=0` for a high-stakes composition where the debate should reason at the tier's full effort | R (trial 13: 3/3 caught the planted concern either way) | R (trial 13: 6/6 solved either way, −45% premium requests, −51% input; 1 revision in 39 steps would have been lost) |
| `SYMPHONY_DELTA_REPAIR`, `SYMPHONY_HEADER_IN_SYSTEM` (on; `=0` turns each off) | A rejected answer resends only what changes (≈55–125 s per answer visit); fixed instructions go in the system message (first-call cache reuse was 0–18%) | `=0` if a trial shows more rejections or a lower cache share | R (trials 4 and 5) |
| `exhaustive` (off) | Coverage vs time, tokens and run size | Every file must be triaged in a mid-size repo. On a very large repo it still stops `partial` at the 200-visit triage check cap | M: a 38,895-file run queued ~9 h of triage and a 316 MB record before Locate existed |
| `maxTriageFiles` (300) | Above it, Locate picks the files: its scope plus the top 50 candidates. The rest are listed in `unlocatedFiles`, not read | Raise it for completeness on mid-size repos; lower it to narrow a big repo further | M (Locate), D (300) |
| `narrowRead` (off), `narrowBudget` (20) | Tokens vs coverage: unmatched files beyond the budget are never read, and each is listed | A cost-bound run where every file would otherwise be triaged (at most `maxTriageFiles` files, or `exhaustive`). It does nothing above that, where Locate already narrows. Keep gap expansion on, so a gap can pull a file back | M: one run, no baseline; files ranked 90–150 were still 57% relevant |
| `maxExpandRounds` (2), `expandWave` (8) | Coverage vs reads | 0 for a narrow, cost-bound question. Never 0 together with `narrowRead` | D |
| `maxGapRounds` (2), `maxChaseRounds` (8, run-wide) | Coverage vs tokens and time (`chase` is the second-largest step) | Lower them only to bound cost; fewer gaps get closed and more are reported as doubts | M for cost, R for coverage |
| `gapsPerChase` (99: one call for all gaps; 1 with `lean`) | Tokens vs time | 1 only when latency matters more than tokens | R: the "at most ~4% of time" estimate subtracted the largest possible warm-up overhead, so it is not a measured ceiling (trial 11) |
| `batchSize` (10, at least 1) | Part starts (a fixed first call of ~19k tokens each) vs context per call | none | M: triage was 20% of cost when it paged 25 files per part; now it preloads 10. Not an A/B |
| `deepBatchSize` (4, at least 1) | The same, for the deep read | After trial 7 | R |
| `batchWave`, `deepWave` | Not settings: derived after planning as size × agents × 3 | none | D |
| `agents` (the plan picks 1–6), `agentsCap` (6, 1 to 6) | Wall time vs concurrent calls (not tokens) | `agentsCap` 4 if reports show rate limits or unread items | R: 6 at once was never measured (trial 1). Rate limits are now waited out and counted |
| `singlePass` (off, pilot; on with `lean`) | Fewer steps vs a pricier tier for the triage read | After trial 3 | R |
| `maxExperiments` (12, at least 1) | Time | Lower it (never 0) for speed. Untimed experiments run in parallel | M: 15 serial experiments took 20% of one run; a tailored 0 left a run stuck |
| `maxDebateRounds` (3, a ceiling), `pragmatistFrom` (3) | Correctness (a hypothesis) vs time and tokens | 1 for speed-bound runs. After round 1, another round plays only when the last one's research found new evidence, so most debates stop sooner; `debateLog` says why it stopped. No challenge after the last round. Eval matrix (20 runs per arm): 0/1/2/3 rounds solved 17/18/19/20 in investigate and 15/17/–/20 in review, the misses mostly unsettled runs, not wrong answers | M for cost: round 2 was ~16% of input and ~21% of time in one run. R for correctness: one run had two verified corrections (trial 9) |
| `keepUnchallenged` (off), `readerHypotheses` (on), `gapAimed` (off); the first and last are on with `lean` | Unmeasured | After their A/Bs | R |
| `supportJudge` (off; `judgeBatch` 40) | Catches a real quote attached to a wrong claim vs tokens and a second model family. Does nothing for web findings | `shadow` for high-stakes workspace questions; `enforce` only after calibration (trial 10) | D/R |
| complexity (auto; `lean` caps a rated 4 at 3) | 1: no debate, cheapest. 4: the heaviest model at xhigh effort, plus a second investigator | Force 1 for routine lookups, 4 for high stakes (a chosen 4 is kept). Ratings vary | D |
| `SYMPHONY_TIERS` (e.g. `4=claude-opus-5.5:high`) | A lower effort on the answer saves up to ≈2.5 min per answer visit (estimated). It also lowers hypothesize at complexity 3 and the skeptic, which plays a tier up on another model family that takes the tier's effort | Only after an A/B that checks objections found as well as answers | R: unmeasured |
| improvisation (0) | 0 replays recorded answers at zero tokens; only the saved runs of the same score are read | none | M: loading only the same score's runs takes 0.3 s and 369 MB; loading all 1.2 GB took 5.4 s and 2.3 GB |
| Citation gate (always on) | No model tokens | none | M: failing citations fell from 14.2% to 2.4% |
| `maxSteps` (5000) | A backstop, not a cost bound | none | D |

## What else bounds memory and disk

- **The runs folder** is bounded:
  - compacted after 30 days;
  - above 500 MB, the oldest real runs older than 3 days are compacted early.

  Compacted runs still replay, and real runs are never deleted.
- **`memory.json` is count-capped:**
  - 2,000 facts and 300 lessons;
  - at most 200 facts per run, or per call when there is no run id.
- **The engine** grows its lists in place on each call to `advance`. It serializes a frozen state
  value once, not at every step.

## Profiles

- **Default:** the code defaults, `lean` on.
- **Routine question:** complexity 1.
- **High-stakes workspace question:** complexity 4 and `lean` off (the second
  investigator), with `supportJudge` set to `shadow`.
- **Huge, budget-bound repository:** a lower `maxTriageFiles`. Locate decides what is read there,
  not `narrowRead`. Gap expansion stays on.
- **Cost-bound run:** lower `maxChaseRounds` and `maxDebateRounds`, and accept more reported
  doubts.
