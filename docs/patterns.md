# The algorithm flows

Each pattern is a TypeScript file in [`src/patterns/`](../src/patterns). The diagrams below
are generated from those files by `npm run docs` (a test fails when they are out of date),
with each phase drawn as one box; the table under a diagram lists the steps inside each
phase. In the studio, click ⊕ on a phase to open it.

Legend: 🤖 an AI step (*edits* = an executor that may change files; ×N = split into parallel
sub-agents) · 🔧 a tool the engine runs · 👤 your approval · ◇ a condition the engine
evaluates · plain boxes are engine computations · dashed arrows go back (loops, all bounded).

Shared building blocks (in [`src/patterns/phases/`](../src/patterns/phases)):

| Phase | Used by | What it guarantees |
|---|---|---|
| Competing hypotheses | investigate, fix, implement | At least 3 rival explanations (2 for a routine problem), one of them "none of these" or "the premise is wrong", before any evidence is read. |
| Evidence and citations | investigate, fix, implement, review | Every finding cites `path:line` with a quote, or a URL / named source. The engine checks file citations; failures go to `unverified`, not into the answer. |
| Challenge (debate) | investigate, fix, implement | By complexity: a skeptic (≥2; read-only tools and another model family; at most 5 objections, each naming the finding or quoted claim it attacks; an objection repeated word for word from an earlier round is reported as unresolved instead of researched again, while a reworded one is treated as new), a pragmatist (from complexity `pragmatistFrom`, 3) who triages each one as REAL or THEORETICAL with a cited reason, a second independent investigator (4). REAL objections go back to research, bounded by `maxDebateRounds`; the next answer must resolve, rebut or mark OPEN each one by its tag; those still open are reported. |
| Edit and verify | fix, refactor, implement | An executor edits; the engine captures the diff (an edit that changed nothing is caught), runs the tests and the linter, and triages failures: environment, wrong diagnosis (back to research), or try again, bounded by `maxAttempts`. |
| PR review | fix, refactor, implement | A reviewer reads the diff; blocking comments go back to editing, bounded; you can accept despite the review. |

---

## investigate

Answer a question with evidence, from whatever sources it needs: workspace files, web pages,
experiments, git history, GitHub, dependencies, MCP servers.

1. **Recall and plan.** Facts and lessons from earlier runs are recalled and re-checked
   against today's files, once for the question and again for the sub-questions (within the
   same caps: 12 facts, 6 lessons). The planner splits the question into sub-questions, decides for
   every available source whether it can hold evidence (a reason for each skip), chooses
   how many sub-agents to use (1-6), and may split the question into independent parts.
2. **Hypotheses.** Competing answers before any evidence, each with what would confirm or
   refute it. The engine keeps a tally per hypothesis (`hypothesisStatus`: findings for and
   against, *untested*, *challenged*) after every batch, and later steps steer by it.
   `readerHypotheses: false` (an ablation switch, on by default) keeps the hypotheses from the
   evidence readers, who then may not tag findings; assess, the answer and the debate keep them.
3. **List evidence.** Only what the plan needs. The engine ranks the files by the words they
   share with the question, sub-questions and search terms (`repo.rank`: git grep hits and
   path names, never the AI's hypotheses), so the likeliest are triaged first; it is an order,
   every file is still read. A large repository is searched first (locate, given the engine's
   top matches as a lead and unioned with them) instead of triaging every file, unless
   `exhaustive` is set; every file it did not locate is named in the coverage
   (`unlocatedFiles`). `narrowRead` (opt-in) applies where every file would be triaged (at most
   `maxTriageFiles`, or `exhaustive`): it triages only the files the search matched plus
   `narrowBudget` (20) more, and names every file it leaves unread (`narrowedOut`). A larger
   repository is already narrowed by Locate; to narrow it further, lower `maxTriageFiles`.
4. **Triage → deep read.** Files are read whole by the engine (`preload`) and given to
   sub-agents in parallel batches; an answer that skips a file of its batch is rejected. A
   file the engine could not read is named in the prompt so the step reads it with tools.
   Every relevant file and page is then read completely, and "completely" is the engine's
   call, not the AI's. Each item is checked against the engine's record of what it gave, and
   the check fails closed: no record, or a failed load, counts as not read. A file cut short
   (too long for one prompt, or cut by the call's size budget) gets its remaining lines as a
   chunk (`path#chunk=from-to`), read next, first in the queue, until the file is done; a
   file triage was not given whole goes to the deep read. The reader writes one note per item
   (`readNotes`, checked against the batch). Unreadable items, and one nothing of fit, are
   retried once at the end, one per call, except PDFs and binaries, which would fail the same
   way.
   `singlePass: true` (on with `lean`, below): triage also reads the relevant files in
   depth (following references and history) and writes a checked note per file, and those it
   read completely skip the deep read only if the engine's preload record shows it gave them
   whole (no record: none skip).
5. **Experiments** (after your approval) and **source searches**, in parallel.
6. **Close gaps.** The gap check writes one entry per sub-question, in order: `S<n>:
   ANSWERED [F…]` citing findings, or `S<n>: GAP — what is missing`; the engine derives the
   gaps from it. First the gaps expand the read: the engine ranks the files not yet read by the
   gaps' words (`repo.rank`) and sends up to `expandWave` (8) matches to the deep read, at most
   `maxExpandRounds` (2) times, then checks again. Then targeted research (`gapAimed`, a pilot:
   aimed at what the GAP notes say is missing). It moves on only when no gap is left and
   nothing is queued to read, never on the model's confidence; otherwise it asks you once for
   a hint.
7. **Answer.** Cited by finding id, one answer per sub-question (or OPEN), one ruling per
   hypothesis. The engine appends a coverage section: files not triaged, pages, experiments,
   what could not be read, sources searched and skipped, findings taken on trust.
8. **Challenge.** The debate above; REAL objections reopen research (within the run-wide
   research budget). `keepUnchallenged: true` (off by default, for an A/B) makes the rewrite
   keep word for word the sub-answers no objection named, so it opens no new front.
9. **Support judge** (`supportJudge`: off by default; `shadow`, `enforce`). Each cited
   workspace finding's quote, with the numbered lines around it, its claim and nothing else, is
   shown to another model family. It rules SUPPORTED when those lines bear the claim out, even in
   other words, and UNSUPPORTED when they contradict it or don't show what it adds. Unsupported findings are never remembered;
   in `enforce` they also make the answer partial. Web and other sources are said to be
   uncheckable, never judged.
10. **Settle.** Settled means no unresolved objection, no OPEN sub-answer or objection
   resolution, and enough confidence. A settled answer ends `success`, remembers the findings
   it cited and a lesson built from its checked sub-answers (only when it names a workspace
   file, so the lesson goes stale with the code). Anything else ends `partial`, with the
   reasons in `doubts`, and teaches nothing.

<!-- flow:investigate -->
<!-- Generated from src/patterns by `npm run docs`: edit the pattern, not this block. -->

```mermaid
flowchart TD
  n_start(["Start"])
  n_recall[/"🔧 Recall earlier runs"/]
  n_multiPart{"Several parts?"}
  n_answerParts["🤖 Answer each part ×N"]
  n_answer["🤖 Write answer"]
  n_listOpen["List open questions"]
  n_attachParts["Finish the answer"]
  n_settled{"Settled?"}
  n_noteDoubts["Say why it is unsettled"]
  n_learnAnswer[/"🔧 Remember the outcome"/]
  n_rememberCited[/"🔧 Remember cited facts"/]
  n_done(["Answered · success"])
  n_doubts(["Answered, with open doubts · partial"])
  n_planPhase[["Plan research · 6 steps"]]
  n_hypothesesPhase[["Competing hypotheses · 3 steps"]]
  n_listPhase[["List evidence · 13 steps"]]
  n_triagePhase[["Triage files · 7 steps"]]
  n_deepPhase[["Deep read · 8 steps"]]
  n_experimentPhase[["Run experiments · 12 steps"]]
  n_sourcePhase[["Search sources · 5 steps"]]
  n_gapPhase[["Close gaps · 17 steps"]]
  n_challengePhase[["Challenge the answer · 18 steps"]]
  n_judgePhase[["Support judge · 6 steps"]]
  n_start --> n_planPhase
  n_planPhase --> n_recall
  n_recall -.-> n_planPhase
  n_planPhase --> n_hypothesesPhase
  n_hypothesesPhase --> n_listPhase
  n_listPhase --> n_triagePhase
  n_triagePhase --> n_deepPhase
  n_deepPhase --> n_gapPhase
  n_gapPhase --> n_experimentPhase
  n_experimentPhase --> n_sourcePhase
  n_sourcePhase -.-> n_gapPhase
  n_gapPhase -.-> n_deepPhase
  n_gapPhase --> n_multiPart
  n_multiPart -->|"yes"| n_answerParts
  n_multiPart -->|"no"| n_answer
  n_answerParts --> n_answer
  n_answer --> n_listOpen
  n_listOpen --> n_challengePhase
  n_challengePhase --> n_attachParts
  n_challengePhase -.-> n_gapPhase
  n_attachParts --> n_judgePhase
  n_judgePhase --> n_settled
  n_settled -->|"yes"| n_learnAnswer
  n_settled -->|"no"| n_noteDoubts
  n_learnAnswer --> n_rememberCited
  n_rememberCited --> n_done
  n_noteDoubts --> n_doubts
```

| Phase | What it does | Steps |
| --- | --- | --- |
| Plan research | Available sources, sub-questions, which evidence applies | Lean run? → List sources → Plan research → Recall for the sub-questions → Merge recalled leads → Queue sources |
| Competing hypotheses | Every plausible explanation, each with what would confirm or refute it; how hard it is | Propose hypotheses → Set complexity → Cap the rated complexity |
| List evidence | Only what the plan needs: workspace files, likeliest first (a big repo is searched first), web pages, experiments | Hypotheses for the readers → Workspace? → List every file → Rank files → Count files → Triage every file? → Queue files → Locate files → Queue located files → Web? → List web pages → Experiments? → Design experiments |
| Triage files | Every listed file, in batches | Files left? → Next batch → Single pass? (pilot) → Triage files → Triage and read in depth → Check citations → Record triage |
| Deep read | Every relevant file and listed page, completely | Queue deep reads → Deep reads left? → Next deep batch → Deep read → Check citations → Record deep read → Retry unreadable? → Queue unreadable again |
| Run experiments | With your approval, run and measure | Experiments listed? → Allow experiments? → Queue experiments → Untimed experiments? → Run experiments side by side → Check citations → Record experiments → Timed experiments left? → Next experiment → Run timed experiment → Check citations → Record experiment |
| Search sources | History, GitHub, dependencies, MCP | Sources left? → Next source → Search source → Check citations → Record source |
| Close gaps | Targeted research, then a human hint | Find gaps → Record gaps → Expand the read? → Unread files → Rank by the gaps → Queue gap files → Files queued? → Gap expansion read? → Back to the gaps → Chase gaps? → Aim the research → Close gaps → Check citations → Record gap research → Gaps closed? → Ask for a hint → Use hint |
| Challenge the answer | Skeptic, pragmatist and a second investigator, scaled by complexity | Skeptic? (≥2) → Skeptic → Only repeats? → Report the repeats → Set repeats aside → Objections? → Research them? (rounds left) → Report open objections → Pragmatist? (≥pragmatistFrom) → Pragmatist → Keep every objection → Real objections? → Research objections → Second investigator? (4) → Second investigator → Check citations → Record its evidence → Reconcile |
| Support judge | Off by default: does each cited finding's quote back its claim? | Support judge? → What the judge can check → Lines around each quote → Any to judge? → Support judge → Record the rulings |

<!-- /flow:investigate -->

**Lean** (`lean`, on by default) bundles the settings estimated to cut time and tokens together:
at most one debate round, single-pass triage, gap-aimed research, unchallenged sub-answers kept,
a sub-agent per gap, and an AI-rated complexity 4 capped at 3 (a chosen 4 stays). Turn it off
(studio Features, or `--with lean=false`) if answers get worse; the settings then apply as set.
See [settings.md](settings.md) and the lean trial in [trials.md](trials.md).

## fix

Fix a bug: the diagnosis comes from evidence, you approve it, and the engine (not the AI)
decides whether the tests pass.

fix shares investigate's debate and evidence phases (hypotheses, checked citations, the
skeptic), but not its read pipeline: one research step reads the code (optionally split by
hypothesis, `hypothesesPerResearch`), instead of triage and deep reads.

1. **Run the tests first.** What fails before any edit, the bug or tests already broken, is
   known to the diagnosis and the triage. The command that ran is kept: every later test run
   uses it. A detected `npm test` still reads the test script on each run, so an edit to
   package.json is flagged (`checkFiles`) for the reviewer.
2. **Recall, hypotheses, evidence.** Research and the debate read the findings brief; the
   diagnosis reads the findings in full.
3. **Diagnose** a root cause from the cited evidence; the challenge phase attacks it. Research
   and the diagnosis are given the usual causes of intermittent failures. An intermittent
   failure must name its test as its result line shows it (`flakyTarget`), the test's file, and
   where the fix goes (`fixTarget`: CODE, TEST or ENVIRONMENT).
4. **👤 Approve the plan** (root cause, files, the change, the test).
5. **Show the flake** (with the stability gate, below): before any edit, the gate command must
   make the flaky test fail.
6. **Reproduce first** (`reproduceFirst`, opt-in): a test that reproduces the bug is written,
   proved to fail for the right reason and locked; the fix must leave it unchanged.
7. **Edit and verify.**
   - **Progress.** An edit that changes nothing, returns to the starting workspace, or
     repeats any earlier attempt is not progress.
   - **Lint.** Lint runs only once the tests pass.
   - **Wrong diagnosis.** A failure triaged as a wrong diagnosis goes back to research for a
     new diagnosis (bounded).
   - **Environment problem.** The same patch is tested once more; if it still fails, the run
     gives up with that reason. A failure of the flaky test itself is never an environment
     problem: the patch did not make it stable.
   - **No hiding.** The edit may not hide a failure (retries, skips, longer timeouts, wider
     slack, fewer workers) unless the plan shows the old limit was wrong for measured work.
   - **Budget.** `maxEdits` (8) bounds the tested edits across diagnoses and review rounds.
8. **Stability gate** (opt-in, below), then **PR review**.
   - **Agreement.** The decision must agree with the comments: APPROVE has no BLOCKING
     comment, REQUEST_CHANGES has one. Earlier comments now addressed are RESOLVED.
   - **Weakened checks.** Changed files that configure the checks (`checkFiles`) are flagged,
     so weakening the checks is blocking.
   - **Nothing changed.** If no review edit changes the patch the reviewer saw, which passed
     the checks, a person decides on that exact patch.
   - **Remember.** The outcome is remembered: fixed, or why it failed.

Only the tests the command runs are checked. In this repository the root `npm test` does not
run `packages/ui`, so set `testCommand` for a fix there.

### Flaky tests: the stability gate

One green run, or a red run then a green re-run, cannot tell a repaired flaky test from a lucky
one. The gate is off by default (`maxStabilityRuns` and `autoStabilityRuns` are 0), and a run
without it gains only three steps with no I/O. Arm it with `maxStabilityRuns` (always), or with
`autoStabilityRuns` (only when the diagnosis finds the failure intermittent, or when a failure
passes on a re-run).

- **The command.** `stabilityCommand` must make the flaky test fail (under load, shuffled with
  a logged seed, or the whole suite) and print each test's result. For vitest add
  `--reporter=verbose`: under CI its default reporter prints no passing test. Empty: the test
  command.
- **Control.** Before any edit, the command runs fresh until the flaky test's own failure line
  shows (`maxControlRuns`, 20). If it never fails, a person decides; unattended, the run stops
  at "Flake not shown". Editing anyway, or a gate armed after an edit (a re-diagnosis, or a
  re-run that passed), has no control, so the patch is never certified.
- **Runs.** After verify, the command runs fresh until the flaky test has passed `maxStableRuns`
  times. That is at least `runsNeeded(stabilityTolerance, maxEdits)`: 49 runs for a tolerance of
  0.1 across 8 patches, 29 for one. A failure, or a pass only on a retry, sends the patch back
  through the edit loop's budgets. Runs that show neither (another test failed, a timeout,
  output cut) do not count. If more than a quarter of the runs are like that, the patch is not
  certified.
- **Masking flags.** These go to a person; unattended, the patch is not certified:
  - the flaky test's own file changed (a retry or a sleep added there looks like a new test);
  - other tests' lines were changed or removed, or added ones skip, invert, retry or lengthen a
    test;
  - added code touches retries, timeouts, slack, workers or sleeps;
  - assertions were removed;
  - files that configure the tests changed;
  - the diff cannot show a file (binary, or cut);
  - more tests are skipped, todo or expected-fail than in the control.

  For an intermittent failure the edit is asked to put its regression test in a new test file,
  which is not flagged. New files are shown in the diff as additions.

  These checks are heuristics. A loosened limit and a real fix of that limit look alike (raising
  `TIME_SLACK` and adding a time floor both touch the same line), so the person decides. A
  certified patch still goes through the review, which reads the report and the flags.
- **Certified** means: under that command, the flaky test's failure rate is below
  `stabilityTolerance` at 95% across `maxEdits` patches. It does not mean "never flaky". The
  report (`stabilityReport`) says so. Anything less ends at "Not certified" (partial): the patch
  is kept as a file, never applied, and the lesson is remembered with open doubts.
- **Cost.** About three steps per run (about 150 per patch by default); `maxSteps` (1000) fits
  the control and five or so measured patches. A run that reaches the limit ends partial, never
  Fixed.
- **One way.** Once armed, a re-diagnosis that no longer calls the failure intermittent does not
  disarm the gate.
- **The test's name.** `flakyTarget` is the text on the line where the runner reports the test's
  result: `src/a.test.ts > suite > test` for vitest, the test's name for node and jest. If it is
  wrong, the control never sees it fail, and the run stops at "Flake not shown".

<!-- flow:fix -->
<!-- Generated from src/patterns by `npm run docs`: edit the pattern, not this block. -->

```mermaid
flowchart TD
  n_start(["Start"])
  n_baseline[/"🔧 Run tests first"/]
  n_snapshot[/"🔧 Snapshot workspace"/]
  n_recall[/"🔧 Recall earlier runs"/]
  n_approve{{"👤 Approve plan"}}
  n_reproduceFirstOn{"Reproduce first?"}
  n_reproduced{"Tests locked?"}
  n_reviewStopped(["Stopped at review · partial"])
  n_learnFixed[/"🔧 Remember the outcome"/]
  n_learnFailed[/"🔧 Remember the failure"/]
  n_learnUncertified[/"🔧 Remember the outcome"/]
  n_fixed(["Fixed · success"])
  n_uncertified(["Not certified · partial"])
  n_gaveUp(["Gave up · failed"])
  n_rejected(["Plan rejected · partial"])
  n_hypothesesPhase[["Competing hypotheses · 2 steps"]]
  n_diagnosePhase[["Diagnose · 4 steps"]]
  n_challengePhase[["Challenge the answer · 18 steps"]]
  n_controlPhase[["Show the flake · 12 steps"]]
  n_testFirstPhase[["Tests first · 19 steps"]]
  n_editPhase[["Edit and verify · 20 steps"]]
  n_stabilityPhase[["Stability gate · 14 steps"]]
  n_prReviewPhase[["PR review · 5 steps"]]
  n_start --> n_baseline
  n_baseline --> n_snapshot
  n_snapshot --> n_recall
  n_recall --> n_hypothesesPhase
  n_learnFixed --> n_fixed
  n_learnFailed --> n_gaveUp
  n_learnUncertified --> n_uncertified
  n_hypothesesPhase --> n_diagnosePhase
  n_diagnosePhase --> n_challengePhase
  n_challengePhase --> n_approve
  n_challengePhase -.-> n_diagnosePhase
  n_approve -->|"approved"| n_controlPhase
  n_controlPhase --> n_reproduceFirstOn
  n_reproduceFirstOn -->|"tests first"| n_testFirstPhase
  n_reproduceFirstOn -->|"no"| n_editPhase
  n_reproduced -.->|"yes"| n_testFirstPhase
  n_reproduced -->|"no"| n_prReviewPhase
  n_testFirstPhase --> n_reviewStopped
  n_testFirstPhase --> n_editPhase
  n_testFirstPhase --> n_prReviewPhase
  n_approve -->|"rejected"| n_rejected
  n_editPhase --> n_stabilityPhase
  n_editPhase --> n_learnFailed
  n_editPhase -.-> n_diagnosePhase
  n_stabilityPhase --> n_reproduced
  n_stabilityPhase -.-> n_editPhase
  n_stabilityPhase --> n_prReviewPhase
  n_stabilityPhase --> n_learnUncertified
  n_prReviewPhase --> n_learnFixed
  n_prReviewPhase -.-> n_editPhase
  n_prReviewPhase --> n_reviewStopped
```

| Phase | What it does | Steps |
| --- | --- | --- |
| Competing hypotheses | Every plausible explanation, each with what would confirm or refute it; how hard it is | Propose hypotheses → Set complexity |
| Diagnose | Evidence for and against every hypothesis, then the root cause | Gather evidence → Check citations → Record evidence → Diagnose |
| Challenge the answer | Skeptic, pragmatist and a second investigator, scaled by complexity | Skeptic? (≥2) → Skeptic → Only repeats? → Report the repeats → Set repeats aside → Objections? → Research them? (rounds left) → Report open objections → Pragmatist? (≥pragmatistFrom) → Pragmatist → Keep every objection → Real objections? → Research objections → Second investigator? (4) → Second investigator → Check citations → Record its evidence → Reconcile |
| Show the flake | With the stability gate: before the edit, the flaky test must fail under the gate command | Arm the stability gate? → Show the flake first? → Workspace unpatched? → No edit yet? → No control possible → Start the control → Run before the edit → Count control run → Run the control again? → Flake shown? → Edit without the flake shown? → Flake not shown |
| Tests first | Tests written before the code must fail for the right reason, then stay locked | Plan the reproducing test → Write tests first → Capture tests → Only tests changed? → Not accepted → Run tests (must fail) → Red? → Not accepted → Failing for the right reason? → Right reason? → Not accepted → Try again? → Write them again → Implement anyway? → Lock tests → Tests are the base → Tests untouched? → Same tests? → Tests were changed |
| Edit and verify | Edit; the engine diffs and runs the tests; failures are triaged | Edit → Capture diff → Anything new? → No progress → Run tests → Lint? → No lint run → Run lint → Count attempt → Tests pass? → Attempts left? → Triage failure → Environment? → Run the tests again? → Run again → The reviewed patch? → Back to the reviewed patch → Diagnosis wrong? → Diagnose again? → Back to diagnosis |
| Stability gate | With the gate: the patch passes the flaky test in fresh runs, with no masking edits, or is not certified | Stability gate? → Start the gate → Run again (gate) → Count gate run → Run the gate again? → Flaky test failed? → Not stable → Masking flags → Certified? → Masking flags? → Fixed, or hidden? → Certify → Reviewed patch certified? → Not certified |
| PR review | Review the change; blocking comments go back to editing until approved | PR review → Approved? → Review again? → Back to editing → Accept despite review? |

<!-- /flow:fix -->

## refactor

Restructure code without changing behaviour. The tests are the oracle: they must pass
before anything changes and after.

1. **Green baseline.** The engine runs the tests first; a red baseline stops the run (a
   refactor cannot prove it preserved behaviour that was already broken).
2. **Plan** the files, steps and the invariants that must not change; **👤 approve** it.
3. **Edit and verify** against the invariants. Bugs noticed on the way are reported
   (`noticedBugs`), not fixed.
4. **PR review.**

<!-- flow:refactor -->
<!-- Generated from src/patterns by `npm run docs`: edit the pattern, not this block. -->

```mermaid
flowchart TD
  n_start(["Start"])
  n_reviewStopped(["Stopped at review · partial"])
  n_refactored(["Refactored · success"])
  n_gaveUp(["Gave up · failed"])
  n_notGreen(["Tests failing before · failed"])
  n_rejected(["Plan rejected · partial"])
  n_baselinePhase[["Green baseline · 3 steps"]]
  n_planPhase[["Plan · 2 steps"]]
  n_editPhase[["Edit and verify · 17 steps"]]
  n_prReviewPhase[["PR review · 5 steps"]]
  n_start --> n_baselinePhase
  n_baselinePhase --> n_notGreen
  n_baselinePhase --> n_planPhase
  n_planPhase --> n_editPhase
  n_planPhase --> n_rejected
  n_editPhase --> n_prReviewPhase
  n_editPhase --> n_gaveUp
  n_prReviewPhase --> n_refactored
  n_prReviewPhase -.-> n_editPhase
  n_prReviewPhase --> n_reviewStopped
```

| Phase | What it does | Steps |
| --- | --- | --- |
| Green baseline | Tests must pass before anything changes | Run tests first → Green? → Snapshot workspace |
| Plan | Files, steps and the behaviour that must not change | Plan refactoring → Approve plan |
| Edit and verify | Edit; the engine diffs and runs the tests; failures are triaged | Edit → Capture diff → Anything new? → No progress → Run tests → Lint? → No lint run → Run lint → Count attempt → Tests pass? → Attempts left? → Triage failure → Environment? → Run the tests again? → Run again → The reviewed patch? → Back to the reviewed patch |
| PR review | Review the change; blocking comments go back to editing until approved | PR review → Approved? → Review again? → Back to editing → Accept despite review? |

<!-- /flow:refactor -->

## implement

Build a feature. Passing tests are not enough: every acceptance criterion must be met, with
evidence.

1. **Baseline** tests, then **competing approaches** (the hypotheses phase) and evidence
   from the code.
2. **Design** with acceptance criteria; the challenge phase attacks it; **👤 approve** it.
3. **Tests first.** Tests written before the code must fail, for the right reason; then they
   are locked, and the engine checks that edits leave them untouched.
4. **Edit and verify** against the locked tests.
5. **PR review**, then an **acceptance review**: each criterion met, with evidence, or the
   edit goes back (bounded).

<!-- flow:implement -->
<!-- Generated from src/patterns by `npm run docs`: edit the pattern, not this block. -->

```mermaid
flowchart TD
  n_start(["Start"])
  n_recall[/"🔧 Recall earlier runs"/]
  n_approve{{"👤 Approve design"}}
  n_testFirstStopped(["Stopped at tests · partial"])
  n_reviewStopped(["Stopped at review · partial"])
  n_learnImplemented[/"🔧 Remember the outcome"/]
  n_learnFailed[/"🔧 Remember the failure"/]
  n_implemented(["Implemented · success"])
  n_incomplete(["Criteria unmet · partial"])
  n_gaveUp(["Gave up · failed"])
  n_notGreen(["Tests failing before · failed"])
  n_rejected(["Design rejected · partial"])
  n_baselinePhase[["Green baseline · 3 steps"]]
  n_hypothesesPhase[["Competing approaches · 2 steps"]]
  n_designPhase[["Design · 4 steps"]]
  n_challengePhase[["Challenge the answer · 18 steps"]]
  n_testFirstPhase[["Tests first · 18 steps"]]
  n_editPhase[["Edit and verify · 20 steps"]]
  n_prReviewPhase[["PR review · 5 steps"]]
  n_acceptancePhase[["Acceptance review · 4 steps"]]
  n_start --> n_baselinePhase
  n_baselinePhase --> n_notGreen
  n_baselinePhase --> n_recall
  n_recall --> n_hypothesesPhase
  n_learnImplemented --> n_implemented
  n_learnFailed --> n_gaveUp
  n_hypothesesPhase --> n_designPhase
  n_designPhase --> n_challengePhase
  n_challengePhase --> n_approve
  n_challengePhase -.-> n_designPhase
  n_approve -->|"approved"| n_testFirstPhase
  n_approve -->|"rejected"| n_rejected
  n_testFirstPhase --> n_testFirstStopped
  n_testFirstPhase --> n_editPhase
  n_testFirstPhase --> n_acceptancePhase
  n_editPhase -.-> n_testFirstPhase
  n_editPhase --> n_learnFailed
  n_editPhase --> n_prReviewPhase
  n_editPhase -.-> n_designPhase
  n_prReviewPhase --> n_learnImplemented
  n_prReviewPhase -.-> n_editPhase
  n_prReviewPhase --> n_reviewStopped
  n_acceptancePhase --> n_prReviewPhase
  n_acceptancePhase --> n_incomplete
  n_acceptancePhase --> n_editPhase
```

| Phase | What it does | Steps |
| --- | --- | --- |
| Green baseline | Tests must pass before anything changes, or a failure could not be told apart | Run tests first → Green? → Snapshot workspace |
| Competing approaches | Every plausible explanation, each with what would confirm or refute it; how hard it is | Propose hypotheses → Set complexity |
| Design | Evidence for and against each approach, then a design with acceptance criteria | Explore the code → Check citations → Record evidence → Design |
| Challenge the answer | Skeptic, pragmatist and a second investigator, scaled by complexity | Skeptic? (≥2) → Skeptic → Only repeats? → Report the repeats → Set repeats aside → Objections? → Research them? (rounds left) → Report open objections → Pragmatist? (≥pragmatistFrom) → Pragmatist → Keep every objection → Real objections? → Research objections → Second investigator? (4) → Second investigator → Check citations → Record its evidence → Reconcile |
| Tests first | Tests written before the code must fail for the right reason, then stay locked | Write tests first → Capture tests → Only tests changed? → Not accepted → Run tests (must fail) → Red? → Not accepted → Failing for the right reason? → Right reason? → Not accepted → Try again? → Write them again → Implement anyway? → Lock tests → Tests are the base → Tests untouched? → Same tests? → Tests were changed |
| Edit and verify | Edit; the engine diffs and runs the tests; failures are triaged | Edit → Capture diff → Anything new? → No progress → Run tests → Lint? → No lint run → Run lint → Count attempt → Tests pass? → Attempts left? → Triage failure → Environment? → Run the tests again? → Run again → The reviewed patch? → Back to the reviewed patch → Diagnosis wrong? → Diagnose again? → Back to diagnosis |
| PR review | Review the change; blocking comments go back to editing until approved | PR review → Approved? → Review again? → Back to editing → Accept despite review? |
| Acceptance review | Every criterion met, with evidence; unmet ones go back to editing | Acceptance review → All met? → Review again? → Back to editing |

<!-- /flow:implement -->

## backlog

Turn a document of improvements (a file, pasted text, or what investigate found) into
separate requests, and play each one as its own run.

1. **Extract items**: self-contained requests, at most 10.
2. **👤 Pick items** by number (or all). Invalid numbers are asked again.
3. **Queue.** Each pick becomes its own run of `runPattern` (implement by default, or fix or
   refactor), with its own worktree, approvals and PR review. A failed item does not stop
   the rest.

<!-- flow:backlog -->
<!-- Generated from src/patterns by `npm run docs`: edit the pattern, not this block. -->

```mermaid
flowchart TD
  n_start(["Start"])
  n_hasPattern{"Pattern given?"}
  n_defaultPattern["Use implement"]
  n_knownPattern{"Playable?"}
  n_extract["🤖 Extract items"]
  n_hasItems{"Anything to do?"}
  n_choose{{"👤 Pick items"}}
  n_validPicks{"Valid numbers?"}
  n_rejectPicks["Ask again"]
  n_picked{"Picked some?"}
  n_queuePicks["Queue picks"]
  n_queueAll["Queue all"]
  n_hasQueue{"Queue empty?"}
  n_queued(["Items queued (each plays as its own run) · success"])
  n_nothing(["Nothing to do · success"])
  n_badPick(["No valid item numbers · failed"])
  n_unknown(["Unknown pattern · failed"])
  n_start --> n_hasPattern
  n_hasPattern -->|"yes"| n_knownPattern
  n_hasPattern -->|"no"| n_defaultPattern
  n_defaultPattern --> n_knownPattern
  n_knownPattern -->|"yes"| n_extract
  n_knownPattern -->|"no"| n_unknown
  n_extract --> n_hasItems
  n_hasItems -->|"yes"| n_choose
  n_hasItems -->|"no"| n_nothing
  n_choose --> n_picked
  n_picked -->|"yes"| n_validPicks
  n_validPicks -->|"yes"| n_queuePicks
  n_validPicks -->|"no"| n_rejectPicks
  n_rejectPicks -.->|"ask again"| n_choose
  n_picked -->|"no"| n_queueAll
  n_queuePicks --> n_hasQueue
  n_queueAll --> n_hasQueue
  n_hasQueue -->|"yes"| n_queued
  n_hasQueue -->|"no"| n_badPick
```

<!-- /flow:backlog -->

## review

Review a branch or PR for bugs and risks, read-only. Only real issues are reported.

1. **Collect the diff.** No changes ends `failed` ("no changes found"), not "looks good".
2. **Find issues** in parallel parts (as many sub-agents as the collector chose). Each issue
   cites the code; the citations are checked before an issue counts.
3. **Report**, or **Looks good** when nothing held up. A review that could not run ends
   `failed`.

<!-- flow:review -->
<!-- Generated from src/patterns by `npm run docs`: edit the pattern, not this block. -->

```mermaid
flowchart TD
  n_start(["Start"])
  n_collect["🤖 Collect diff"]
  n_hasDiff{"Anything changed?"}
  n_analyze["🤖 Find issues ×N"]
  n_analyzed{"Reviewed?"}
  n_checkReview[/"🔧 Check citations"/]
  n_mergeReview["Record issues"]
  n_hasIssues{"Issues?"}
  n_report["🤖 Write report"]
  n_cleanReport["Nothing found"]
  n_issues(["Issues reported · success"])
  n_clean(["Looks good · success"])
  n_noDiff(["No changes found · failed"])
  n_notReviewed(["Could not review · failed"])
  n_start --> n_collect
  n_collect --> n_hasDiff
  n_hasDiff -->|"yes"| n_analyze
  n_hasDiff -->|"no"| n_noDiff
  n_analyze --> n_analyzed
  n_analyzed -->|"yes"| n_checkReview
  n_analyzed -->|"no"| n_notReviewed
  n_checkReview --> n_mergeReview
  n_mergeReview --> n_hasIssues
  n_hasIssues -->|"yes"| n_report
  n_hasIssues -->|"no"| n_cleanReport
  n_report --> n_issues
  n_cleanReport --> n_clean
```

<!-- /flow:review -->

## analyze

Explore a dataset to answer a question. Every analysis runs as code (scratch scripts), so
the numbers are reproducible even when the route was improvised.

1. **Profile** the data.
2. **Decide the next move** (a solo point). In classical and cool, the written melody plays:
   `maxAnalyses` analyses, then conclude. From swing up, the AI decides after each analysis
   whether to dig further or conclude; in bebop and free it also plays several takes that a
   bandleader merges.
3. **Run the analysis** as code and record it, until the budget is spent.
4. **Conclude** with caveats, citing the analyses.

<!-- flow:analyze -->
<!-- Generated from src/patterns by `npm run docs`: edit the pattern, not this block. -->

```mermaid
flowchart TD
  n_start(["Start"])
  n_profile["🤖 Profile the data (edits)"]
  n_mergeProfile["Record profile"]
  n_budget{"Analyses left?"}
  n_muse["🤖 Decide next move"]
  n_analyze["🤖 Run analysis (edits)"]
  n_record["Record analysis"]
  n_conclude["🤖 Conclude"]
  n_done(["Concluded · success"])
  n_start --> n_profile
  n_profile --> n_mergeProfile
  n_mergeProfile --> n_budget
  n_budget -->|"yes"| n_muse
  n_budget -->|"budget spent"| n_conclude
  n_muse -->|"run this analysis"| n_analyze
  n_muse -->|"enough evidence: conclude"| n_conclude
  n_analyze --> n_record
  n_record -.->|"next"| n_budget
  n_conclude --> n_done
```

<!-- /flow:analyze -->

See also: [how the studio works](./studio.md) and [the maestro](./maestro.md).
