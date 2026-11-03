/**
 * The stability gate for a flaky test (fix only, off by default). One green run cannot tell a
 * repaired flaky test from a lucky one, so when the gate is armed:
 *
 * 1. Control: before any edit, the gate command runs until the flaky test fails (at most
 *    maxControlRuns). Without that failure, clean runs later would prove nothing: a person
 *    decides whether to edit anyway, and the fix can then not be certified.
 * 2. Gate: a patch that passed verify runs the gate command again, fresh, until it has
 *    maxStableRuns clean runs of the flaky test (at least runsNeeded(stabilityTolerance,
 *    maxEdits)). A failure of that test sends the patch back to the edit loop (its budgets hold;
 *    the triage may not call it ENVIRONMENT). Runs where it neither passed nor failed visibly
 *    (another test failed, a timeout, output cut, its line missing) do not count.
 * 3. Masking flags: edits that make a flaky test pass without fixing it are flagged (its own
 *    file changed, retries, skips, timeouts, slack, workers, sleeps, removed assertions, test
 *    config, untracked or cut diff, more skipped tests than the control): a person decides.
 *
 * Certified means: under the gate command, the flaky test's failure rate is below
 * stabilityTolerance at 95% across maxEdits patches. Anything less ends partial (not certified)
 * with the patch kept as a file, never "Fixed".
 */
import { runsNeeded } from '../../core/expr.js';
import type { ScoreEdge, ScoreNode, StateField } from '../../core/types.js';
import type { Fragment } from './debate.js';

/**
 * A test's own lines in a run's output (vitest --reporter=verbose, jest --verbose, node --test,
 * pytest -v): failed, passed, passed only on a retry. Read with linesWith(output, flakyTarget).
 */
export const FAILED_LINE = '^ *(FAIL|×|✕|✖|✗) |FAILED|ERROR';
export const PASSED_LINE = '^ *(✓|✔|PASS) |PASSED';
export const RETRIED_LINE = 'retry x|RERUN';

/** The flaky test failed in this output (its own line, not another test's). */
export const targetFailed = (output: string) =>
  `!empty(flakyTarget) && count(linesWith(${output}, flakyTarget), "${FAILED_LINE}") > 0`;
const targetRetried = (output: string) =>
  `!empty(flakyTarget) && count(linesWith(${output}, flakyTarget), "${RETRIED_LINE}") > 0`;
const targetPassed = (output: string) =>
  `count(linesWith(${output}, flakyTarget), "${PASSED_LINE}") > 0`;

/** Added lines that can make a flaky test pass without fixing it (a heuristic: a person decides). */
const MASKING_LINE =
  '^[+][^+].*([.](skip|todo|fails|only)[(]|skipIf|runIf|retry|repeats|[Tt]imeout|TIMEOUT|[Ss]lack|SLACK|[Tt]olerance|TOLERANCE|[Tt]hreshold|THRESHOLD|[Ww]orkers|[Pp]arallel|sleep)';
const ASSERTION = '(expect|assert)';

export const STABILITY_STATE: readonly StateField[] = [
  {
    name: 'maxStabilityRuns',
    type: 'number',
    initial: 0,
    min: 0,
    description:
      'Opt-in for a flaky test: fresh runs the patch must pass before it is Fixed (0: off; raised to what stabilityTolerance needs)',
  },
  {
    name: 'autoStabilityRuns',
    type: 'number',
    initial: 0,
    min: 0,
    description:
      'Opt-in: the same, but only when the diagnosis finds the failure intermittent or a failure passes when run again (0: off)',
  },
  {
    name: 'stabilityTolerance',
    type: 'number',
    initial: 0.1,
    min: 0.01,
    description:
      'With the gate: the highest failure rate of the flaky test a certified fix may keep (95% across maxEdits patches; below 1). Sets the least number of runs',
  },
  {
    name: 'maxControlRuns',
    type: 'number',
    initial: 20,
    min: 1,
    description:
      'With the gate: runs before the edit that must show the flaky test failing (the control)',
  },
  {
    name: 'stabilityCommand',
    type: 'string',
    description:
      'With the gate: the command that makes the flaky test fail (e.g. under load, or shuffled with a logged seed). It must print each test (vitest: --reporter=verbose). Empty: the test command',
  },
  { name: 'stabilityArmed', type: 'boolean', description: 'The gate is on for this run' },
  { name: 'gateCommand', type: 'string', description: 'The command the control and gate run' },
  { name: 'maxStableRuns', type: 'number', description: 'Clean runs the patch needs (computed)' },
  { name: 'controlTarget', type: 'string', description: 'The test the control ran for' },
  { name: 'controlCommand', type: 'string', description: 'The command the control ran' },
  { name: 'controlHash', type: 'string', description: 'The workspace when the control ran' },
  { name: 'controlRuns', type: 'number' },
  { name: 'controlTargetFails', type: 'number' },
  { name: 'controlPassed', type: 'boolean' },
  { name: 'controlOutput', type: 'string', description: "The control's last run" },
  {
    name: 'reproductionProved',
    type: 'boolean',
    description: 'The flaky test failed on the unpatched code under the gate command',
  },
  { name: 'stabilityRuns', type: 'number' },
  { name: 'stableTargetFails', type: 'number' },
  { name: 'stableInconclusive', type: 'number' },
  { name: 'stablePassed', type: 'boolean' },
  { name: 'stableOutput', type: 'string', description: "The gate's last run" },
  { name: 'stableHash', type: 'string', description: 'The patch the gate runs measured' },
  { name: 'unstableHash', type: 'string', description: 'The patch whose flaky test failed' },
  {
    name: 'maskingFlags',
    type: 'string[]',
    description: 'Edits that can make a flaky test pass without fixing it: a person decides',
  },
  { name: 'certifiedHashes', type: 'string[]', description: 'Patches the gate certified' },
  {
    name: 'stabilityReport',
    type: 'string',
    description: 'What the stability gate measured, and what it does not show',
  },
];

export interface StabilityConfig {
  /** After the control, or when it does not run (fix: reproduceFirstOn). */
  readonly next: string;
  /** A patch with no gate, or certified (fix: reproduced). */
  readonly passed: string;
  /** The flaky test failed on the patch: the edit loop's budget check (attemptsLeft). */
  readonly unstable: string;
  /** Not certified: kept as a file, with a doubtful lesson (fix: learnUncertified). */
  readonly uncertified: string;
  /** The person's decision on a reviewed patch (fix: acceptAnyway), once it is certified. */
  readonly reviewed: string;
}

const N = (x: string) => `text(${x})`;
const flag = (cond: string, text: string) => `if(${cond}, ["${text}"], [])`;

export function stabilityPhases(cfg: StabilityConfig): {
  readonly control: Fragment;
  readonly gate: Fragment;
} {
  const controlNodes: ScoreNode[] = [
    {
      id: 'armStability',
      kind: 'compute',
      label: 'Arm the stability gate?',
      // A count chosen for the run wins; otherwise the diagnosis decides (autoStabilityRuns).
      assign: [
        {
          field: 'maxStableRuns',
          expr: 'if(maxStabilityRuns > 0, maxStabilityRuns, if(nondeterministic, autoStabilityRuns, 0))',
        },
        { field: 'stabilityArmed', expr: 'maxStableRuns > 0' },
        {
          field: 'gateCommand',
          expr: 'if(empty(stabilityCommand), testCommand, stabilityCommand)',
        },
      ],
    },
    {
      id: 'controlOn',
      kind: 'condition',
      label: 'Show the flake first?',
      expression: 'stabilityArmed && !empty(flakyTarget) && controlTarget != flakyTarget',
    },
    {
      id: 'controlSnapshot',
      kind: 'tool',
      label: 'Workspace unpatched?',
      tool: 'git.diff',
      output: { hash: 'controlHash' },
    },
    {
      id: 'controlClean',
      kind: 'condition',
      label: 'No edit yet?',
      // After a re-diagnosis the workspace holds the last patch: a control there proves nothing.
      expression: 'controlHash == baseDiffHash',
    },
    {
      id: 'noControl',
      kind: 'compute',
      label: 'No control possible',
      assign: [
        { field: 'controlTarget', expr: 'flakyTarget' },
        { field: 'controlCommand', expr: 'gateCommand' },
        { field: 'controlRuns', expr: '0' },
        { field: 'controlTargetFails', expr: '0' },
        { field: 'reproductionProved', expr: 'false' },
      ],
    },
    {
      id: 'startControl',
      kind: 'compute',
      label: 'Start the control',
      assign: [
        { field: 'controlTarget', expr: 'flakyTarget' },
        { field: 'controlCommand', expr: 'gateCommand' },
        { field: 'controlRuns', expr: '0' },
        { field: 'controlTargetFails', expr: '0' },
        { field: 'reproductionProved', expr: 'false' },
      ],
    },
    {
      id: 'runControl',
      kind: 'tool',
      label: 'Run before the edit',
      tool: 'tests.run',
      // Fresh every time (no reuse): each run is a sample.
      inputs: { command: 'controlCommand', timeoutMs: 'testTimeoutMs' },
      output: { passed: 'controlPassed', output: 'controlOutput' },
      maxVisits: 21,
      visitsFrom: 'maxControlRuns + 1',
    },
    {
      id: 'countControl',
      kind: 'compute',
      label: 'Count control run',
      assign: [
        { field: 'controlRuns', expr: 'controlRuns + 1' },
        {
          field: 'controlTargetFails',
          expr: `controlTargetFails + if(!controlPassed && (${targetFailed('controlOutput')}), 1, 0)`,
        },
        { field: 'reproductionProved', expr: 'controlTargetFails > 0' },
      ],
    },
    {
      id: 'controlDone',
      kind: 'condition',
      label: 'Run the control again?',
      expression: '!reproductionProved && controlRuns < maxControlRuns',
    },
    {
      id: 'controlProved',
      kind: 'condition',
      label: 'Flake shown?',
      expression: 'reproductionProved',
    },
    {
      id: 'notReproduced',
      kind: 'approval',
      label: 'Edit without the flake shown?',
      message:
        'The flaky test did not fail in any control run before the edit, so later clean runs cannot show the fix changed anything. Approve to edit anyway: the fix will not be certified (at best it ends "not certified", kept as a file). Reject to stop, and find a command that makes it fail (under load, shuffled, the whole suite).',
      shows: ['flakyTarget', 'controlCommand', 'controlRuns', 'controlOutput'],
      writes: [],
      // Unattended, an unshown flake is not edited on.
      unattended: 'reject',
    },
    { id: 'flakeNotShown', kind: 'end', label: 'Flake not shown', outcome: 'partial' },
  ];
  const controlEdges: ScoreEdge[] = [
    { id: 'armStability-controlOn', from: 'armStability', to: 'controlOn' },
    { id: 'controlOn-snapshot', from: 'controlOn', to: 'controlSnapshot', branch: 'then' },
    { id: 'controlOn-next', from: 'controlOn', to: cfg.next, branch: 'else' },
    { id: 'controlSnapshot-clean', from: 'controlSnapshot', to: 'controlClean' },
    { id: 'controlClean-start', from: 'controlClean', to: 'startControl', branch: 'then' },
    {
      id: 'controlClean-none',
      from: 'controlClean',
      to: 'noControl',
      branch: 'else',
      label: 'already patched',
    },
    { id: 'noControl-next', from: 'noControl', to: cfg.next },
    { id: 'startControl-run', from: 'startControl', to: 'runControl' },
    { id: 'runControl-count', from: 'runControl', to: 'countControl' },
    { id: 'countControl-done', from: 'countControl', to: 'controlDone' },
    { id: 'controlDone-again', from: 'controlDone', to: 'runControl', branch: 'then' },
    { id: 'controlDone-proved', from: 'controlDone', to: 'controlProved', branch: 'else' },
    { id: 'controlProved-next', from: 'controlProved', to: cfg.next, branch: 'then' },
    { id: 'controlProved-ask', from: 'controlProved', to: 'notReproduced', branch: 'else' },
    { id: 'notReproduced-next', from: 'notReproduced', to: cfg.next, branch: 'approved' },
    { id: 'notReproduced-stop', from: 'notReproduced', to: 'flakeNotShown', branch: 'rejected' },
  ];

  // Clean runs: the flaky test's own pass line, not retried. Inconclusive: neither its pass nor
  // its failure is visible (another test failed, a timeout, output cut, its line missing).
  const hit = `(${targetFailed('stableOutput')}) || (${targetRetried('stableOutput')}) || (empty(flakyTarget) && !stablePassed)`;
  const clean = `stablePassed && (empty(flakyTarget) || ${targetPassed('stableOutput')})`;
  const certifiable = [
    '!empty(flakyTarget)',
    'reproductionProved',
    'controlTarget == flakyTarget',
    'controlCommand == gateCommand',
    'stableTargetFails == 0',
    'stabilityRuns - stableInconclusive >= maxStableRuns',
    'stableHash == diffHash',
  ].join(' && ');
  const gateNodes: ScoreNode[] = [
    {
      id: 'stableGate',
      kind: 'condition',
      label: 'Stability gate?',
      // Armed before the edit, or late: a failure that passed when run again (ENVIRONMENT).
      expression: 'stabilityArmed || (autoStabilityRuns > 0 && envRechecks > 0)',
    },
    {
      id: 'startStable',
      kind: 'compute',
      label: 'Start the gate',
      assign: [
        {
          field: 'maxStableRuns',
          expr: 'if(maxStableRuns > 0, maxStableRuns, autoStabilityRuns)',
        },
        {
          field: 'maxStableRuns',
          expr: 'if(maxStableRuns < runsNeeded(stabilityTolerance, maxEdits), runsNeeded(stabilityTolerance, maxEdits), maxStableRuns)',
        },
        { field: 'stabilityArmed', expr: 'true' },
        { field: 'stabilityRuns', expr: '0' },
        { field: 'stableTargetFails', expr: '0' },
        { field: 'stableInconclusive', expr: '0' },
        { field: 'stableHash', expr: 'diffHash' },
      ],
    },
    {
      id: 'runStable',
      kind: 'tool',
      label: 'Run again (gate)',
      tool: 'tests.run',
      inputs: { command: 'gateCommand', timeoutMs: 'testTimeoutMs' },
      output: { passed: 'stablePassed', output: 'stableOutput' },
      maxVisits: runsNeeded(0.1, 8) * 2,
      // Every patch may be measured, and up to a quarter of the runs may be inconclusive.
      visitsFrom: 'maxStableRuns * 2 * (maxEdits + maxEnvRechecks + 1) + 1',
    },
    {
      id: 'countStable',
      kind: 'compute',
      label: 'Count gate run',
      assign: [
        { field: 'stabilityRuns', expr: 'stabilityRuns + 1' },
        { field: 'stableTargetFails', expr: `stableTargetFails + if(${hit}, 1, 0)` },
        {
          field: 'stableInconclusive',
          expr: `stableInconclusive + if(!(${hit}) && !(${clean}), 1, 0)`,
        },
      ],
    },
    {
      id: 'stableDone',
      kind: 'condition',
      label: 'Run the gate again?',
      expression:
        'stableTargetFails == 0 && stabilityRuns < maxStableRuns + stableInconclusive && stableInconclusive * 4 <= maxStableRuns',
    },
    {
      id: 'stableFailed',
      kind: 'condition',
      label: 'Flaky test failed?',
      expression: 'stableTargetFails > 0',
    },
    {
      id: 'unstable',
      kind: 'compute',
      label: 'Not stable',
      // Back to the edit loop's own budget check: a failure, not an environment.
      assign: [
        { field: 'testsPassed', expr: 'false' },
        { field: 'testOutput', expr: 'stableOutput' },
        { field: 'unstableHash', expr: 'diffHash' },
        { field: 'failureKind', expr: '"PATCH"' },
        {
          field: 'failureReason',
          expr: `"the flaky test " + if(empty(flakyTarget), "run", flakyTarget) + " failed again in gate run " + ${N('stabilityRuns')} + " of " + ${N('maxStableRuns')} + " after the patch passed verify: it is not fixed"`,
        },
      ],
    },
    {
      id: 'checkMasking',
      kind: 'compute',
      label: 'Masking flags',
      assign: [
        {
          field: 'maskingFlags',
          expr: [
            flag(
              '!empty(flakyFile) && includes(changedFiles, flakyFile)',
              "the flaky test's own file changed",
            ),
            flag(
              `count(lines(diff), "${MASKING_LINE}") > 0`,
              'added lines touch retries, skips, timeouts, slack, workers or sleeps',
            ),
            flag(
              `count(lines(diff), "^-[^-].*${ASSERTION}") > count(lines(diff), "^[+][^+].*${ASSERTION}")`,
              'assertions removed',
            ),
            flag('len(checkFiles) > 0', 'files that configure the tests changed'),
            flag(
              'includes(diff, "untracked files:") || includes(diff, "diff truncated at")',
              'new or cut files the diff does not show',
            ),
            flag(
              '!empty(controlOutput) && ((includes(stableOutput, " skipped") && !includes(controlOutput, " skipped")) || (includes(stableOutput, " todo") && !includes(controlOutput, " todo")) || (includes(stableOutput, "expected fail") && !includes(controlOutput, "expected fail")))',
              'more skipped, todo or expected-fail tests than before the edit',
            ),
          ].join(' + '),
        },
      ],
    },
    { id: 'certifiable', kind: 'condition', label: 'Certified?', expression: certifiable },
    {
      id: 'masked',
      kind: 'condition',
      label: 'Masking flags?',
      expression: 'len(maskingFlags) > 0',
    },
    {
      id: 'maskingReview',
      kind: 'approval',
      label: 'Fixed, or hidden?',
      message:
        'The flaky test passed every gate run, but the patch has edits that can make a flaky test pass without fixing it (maskingFlags). Approve if each is a real fix (e.g. a limit measured to be wrong for the work); reject to keep the patch as a file, not certified.',
      shows: ['maskingFlags', 'diff', 'rootCause', 'stabilityRuns', 'controlTargetFails'],
      writes: [],
      unattended: 'reject',
    },
    {
      id: 'certify',
      kind: 'compute',
      label: 'Certify',
      assign: [
        { field: 'certifiedHashes', expr: 'certifiedHashes + [diffHash]' },
        {
          field: 'stabilityReport',
          expr: `"certified: " + flakyTarget + " failed " + ${N('controlTargetFails')} + " of " + ${N('controlRuns')} + " runs of \`" + gateCommand + "\` before the edit and none of " + ${N('stabilityRuns - stableInconclusive')} + " fresh runs after it (" + ${N('stableInconclusive')} + " inconclusive): its failure rate is below " + ${N('stabilityTolerance')} + " at 95% across " + ${N('maxEdits')} + " patches, under that command only" + if(len(maskingFlags) > 0, "; a person accepted: " + join(maskingFlags, "; "), "")`,
        },
      ],
    },
    {
      id: 'reviewedCertified',
      kind: 'condition',
      label: 'Reviewed patch certified?',
      expression: '!stabilityArmed || includes(certifiedHashes, reviewedHash)',
    },
    {
      id: 'uncertify',
      kind: 'compute',
      label: 'Not certified',
      assign: [
        {
          field: 'stabilityReport',
          expr: [
            '"not certified: " + ',
            'if(empty(flakyTarget), "no flaky test was named, so its failures cannot be told from others\' and no control ran", ',
            'if(!reproductionProved, if(controlRuns == 0, "no control: the gate started after an edit, so the flaky test was never shown failing on the unpatched code", "the flaky test did not fail in " + text(controlRuns) + " control runs before the edit"), ',
            'if(controlTarget != flakyTarget || controlCommand != gateCommand, "the control ran another test or command than the gate", ',
            'if(stabilityArmed && reviewedHash == diffHash && !includes(certifiedHashes, diffHash), "the reviewed patch was never measured by the gate", ',
            'if(len(maskingFlags) > 0, "a person did not accept the masking flags: " + join(maskingFlags, "; "), ',
            '"too many gate runs were inconclusive (" + text(stableInconclusive) + " of " + text(stabilityRuns) + "): the flaky test\'s own result was not in the output")))))',
          ].join(''),
        },
      ],
    },
  ];
  const gateEdges: ScoreEdge[] = [
    { id: 'stableGate-start', from: 'stableGate', to: 'startStable', branch: 'then' },
    { id: 'stableGate-passed', from: 'stableGate', to: cfg.passed, branch: 'else' },
    { id: 'startStable-run', from: 'startStable', to: 'runStable' },
    { id: 'runStable-count', from: 'runStable', to: 'countStable' },
    { id: 'countStable-done', from: 'countStable', to: 'stableDone' },
    { id: 'stableDone-again', from: 'stableDone', to: 'runStable', branch: 'then' },
    { id: 'stableDone-failed', from: 'stableDone', to: 'stableFailed', branch: 'else' },
    { id: 'stableFailed-unstable', from: 'stableFailed', to: 'unstable', branch: 'then' },
    { id: 'stableFailed-masking', from: 'stableFailed', to: 'checkMasking', branch: 'else' },
    { id: 'unstable-edit', from: 'unstable', to: cfg.unstable, label: 'still flaky' },
    { id: 'checkMasking-certifiable', from: 'checkMasking', to: 'certifiable' },
    { id: 'certifiable-masked', from: 'certifiable', to: 'masked', branch: 'then' },
    { id: 'certifiable-not', from: 'certifiable', to: 'uncertify', branch: 'else' },
    { id: 'masked-review', from: 'masked', to: 'maskingReview', branch: 'then' },
    { id: 'masked-certify', from: 'masked', to: 'certify', branch: 'else' },
    { id: 'maskingReview-certify', from: 'maskingReview', to: 'certify', branch: 'approved' },
    { id: 'maskingReview-not', from: 'maskingReview', to: 'uncertify', branch: 'rejected' },
    { id: 'certify-passed', from: 'certify', to: cfg.passed },
    { id: 'reviewedCertified-yes', from: 'reviewedCertified', to: cfg.reviewed, branch: 'then' },
    { id: 'reviewedCertified-no', from: 'reviewedCertified', to: 'uncertify', branch: 'else' },
    { id: 'uncertify-learn', from: 'uncertify', to: cfg.uncertified },
  ];

  return {
    control: {
      state: STABILITY_STATE,
      nodes: controlNodes,
      edges: controlEdges,
      entry: 'armStability',
      group: {
        id: 'controlPhase',
        label: 'Show the flake',
        description:
          'With the stability gate: before the edit, the flaky test must fail under the gate command',
        nodes: controlNodes.map((n) => n.id),
      },
    },
    gate: {
      state: [],
      nodes: gateNodes,
      edges: gateEdges,
      entry: 'stableGate',
      group: {
        id: 'stabilityPhase',
        label: 'Stability gate',
        description:
          'With the gate: the patch passes the flaky test in fresh runs, with no masking edits, or is not certified',
        nodes: gateNodes.map((n) => n.id),
      },
    },
  };
}
