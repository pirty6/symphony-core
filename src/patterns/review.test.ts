import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { review } from './index.js';
import { attest } from './phases/reviewRules.js';

const demo = review.demo!;
const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
type Agent = NonNullable<DemoScript['agents']>[string];

function play(over: Partial<DemoScript> = {}, context: Record<string, unknown> = {}) {
  const script: DemoScript = {
    ...demo,
    ...over,
    agents: { ...demo.agents, ...over.agents },
    tools: { ...demo.tools, ...over.tools },
  };
  const r = runScripted(
    compileScore(review, { goal: 'g', context: { ...demo.context, ...context } }),
    script,
  );
  return { r, state: r.state.state, end: r.state.cursor, ran: r.state.steps.map((s) => s.nodeId) };
}

const sound: Agent = (s) => ({
  updates: { newFindings: [], reviewed: (s.files as string[]) ?? [], attestations: attest() },
  verdict: v,
});
const id = (e: string) => e.split(' ')[0]!;
/** The whole change is sound: every claim met, every behaviour tested, nothing missing. */
const soundWhole: Agent = (s) => ({
  updates: {
    wholeFindings: [],
    claimVerdicts: ((s.claimList as string[]) ?? []).map((c) => `${id(c)} MET — src/a.ts:1 — yes`),
    testVerdicts: ((s.behaviours as string[]) ?? []).map(
      (b) => `${id(b)} TESTED — test/a.test.ts:1`,
    ),
    obligationVerdicts: ((s.obligations as string[]) ?? []).map((o) => `${id(o)} FOUND — here`),
    related: (s.files as string[]) ?? [],
    unrelated: [],
  },
  verdict: v,
});
const quiet = { analyze: sound, wholeChange: soundWhole };
const collecting =
  (files: string[], skipped: string[] = [], deleted: string[] = []): Agent =>
  () => ({
    updates: { diffSummary: 'd', claims: 'c', files, skipped, deleted, agents: 1, diffRange: '' },
    verdict: v,
  });

describe('review', () => {
  it("never runs tests or lint (the change's CI does), and gives the reviewers the changed tests", () => {
    const { ran, state, end } = play({
      agents: {
        collect: collecting(['src/a.ts', 'src/a.test.ts'], ['pnpm-lock.yaml — lockfile']),
      },
    });
    expect(review.nodes.some((n) => n.kind === 'tool' && n.tool === 'tests.run')).toBe(false);
    expect(review.state.map((f) => f.name)).not.toContain('verify');
    expect(state.changedTests).toEqual(['src/a.test.ts']);
    expect(ran).toContain('analyze');
    expect(end).toBe('issues');
    expect(String(state.handoff)).toContain(
      "Tests and lint: not run by a review (the change's CI runs them).",
    );
    // What was left out, and why, is in the result.
    expect(state.coverage).toMatch(/Left out: pnpm-lock.yaml — lockfile/);
  });

  it('findings it cannot verify against this checkout are not "looks good"', () => {
    // E.g. the PR's branch is not checked out: every quote is rejected.
    const { r, state, end } = play({
      agents: { wholeChange: soundWhole },
      tools: { checkReview: (s) => ({ valid: [], invalid: s.newFindings }) },
    });
    expect(end).toBe('notVerified');
    expect(r.state.outcome).toBe('partial');
    expect(state.report).toMatch(/^Could not verify the review: 1 finding/);
    expect(state.report).toMatch(/check out the reviewed branch/);
  });

  it('a clean result is "looks good" only when every changed file was reviewed', () => {
    const clean = play({ agents: quiet });
    expect(clean.end).toBe('clean');
    expect(clean.state.report).toMatch(/^No real issues found\. Reviewed: src\/core\/engine\.ts/);
    // Over maxFiles: the rest is named, and the run ends partial.
    const capped = play(
      { agents: { ...quiet, collect: collecting(['src/a.ts', 'src/b.ts', 'src/c.ts']) } },
      { maxFiles: 2 },
    );
    expect(capped.state.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(capped.end).toBe('partlyReviewed');
    expect(capped.r.state.outcome).toBe('partial');
    expect(capped.state.report).toMatch(/Not reviewed \(over maxFiles 2\): src\/c\.ts/);
  });

  it('a part that could not read its files does not throw away the others', () => {
    const { r, state, end } = play(
      {
        agents: {
          collect: collecting(['src/a.ts', 'src/b.ts']),
          analyze: (s) =>
            (s.files as string[])[0] === 'src/b.ts'
              ? {
                  updates: { newFindings: [], reviewed: [], attestations: [] },
                  verdict: { ...v, outcome: 'failed', reason: 'could not read it' },
                }
              : {
                  updates: {
                    newFindings: ['src/a.ts:3 — [BUG] [HIGH] off by one `i < n`'],
                    reviewed: ['src/a.ts'],
                    attestations: attest(['CORRECTNESS']),
                  },
                  verdict: v,
                },
        },
      },
      { filesPerAgent: 1 },
    );
    expect(end).toBe('issues');
    expect(state.findings).toContain('F1 src/a.ts:3 — [BUG] [HIGH] off by one `i < n`');
    expect(state.coverage).toMatch(/Not reviewed \(the reviewer could not read them\): src\/b\.ts/);
    expect(r.state.outcome).toBe('success');
  });

  it('every finding names its category and severity', () => {
    const untagged = play({
      agents: {
        analyze: (s) => ({
          updates: {
            newFindings: ['src/core/engine.ts:120 — counter never resets `attempts += 1`'],
            reviewed: (s.files as string[]) ?? [],
            attestations: attest(['CORRECTNESS']),
          },
          verdict: v,
        }),
      },
    });
    expect(untagged.r.state.outcome).not.toBe('success');
    expect(JSON.stringify(untagged.r.state.steps.at(-1))).toMatch(/CATEGORY one of BUG, SECURITY/);
  });

  it('collects the diff fresh every time: a PR can change on GitHub', () => {
    expect(review.nodes.find((n) => n.id === 'collect')).toMatchObject({ fresh: true });
  });
});

describe('review of a pull request', () => {
  const pr = {
    number: 7,
    base: 'abc123',
    files: ['M\tsrc/a.ts', 'D\tsrc/old.ts'],
    paths: ['src/a.ts', 'src/old.ts'],
    error: '',
  };

  it('reads the PR the engine checked out, and accounts for each of its files', () => {
    const { ran, state } = play({
      tools: { prInfo: () => pr },
      agents: { collect: collecting(['src/a.ts'], [], ['src/old.ts']) },
    });
    expect(ran.slice(0, 4)).toEqual(['start', 'prInfo', 'prFetched', 'collect']);
    expect(state).toMatchObject({ prNumber: 7, prBase: 'abc123', prPaths: pr.paths });
    expect(ran).toContain('analyze');
    expect(review.nodes.find((n) => n.id === 'collect')).toMatchObject({
      reads: expect.arrayContaining(['prBase', 'prFiles']),
    });
  });

  it('a file the PR does not change, or one left unaccounted, is sent back by name', () => {
    let calls = 0;
    const { r } = play({
      tools: { prInfo: () => pr },
      agents: {
        collect: (s) =>
          [
            collecting(['src/a.ts', 'src/other.ts']),
            // The deleted file forgotten.
            collecting(['src/a.ts']),
            collecting(['src/a.ts'], [], ['src/old.ts']),
          ][calls++]!(s, 0),
      },
    });
    const collect = r.state.steps.find((s) => s.nodeId === 'collect')!;
    const [outside, forgotten] = collect.attempts!.map((a) => a.errors.join(' '));
    expect(outside).toMatch(/Not allowed: "src\/other\.ts"/);
    expect(outside).not.toMatch(/Account for every file/);
    expect(forgotten).toMatch(/Account for every file the PR changes/);
    expect(calls).toBe(3);
    expect(r.state.steps.map((x) => x.nodeId)).toContain('analyze');
  });

  it('a PR that could not be fetched ends "Could not review" with why, before any AI step', () => {
    const { r, state, end, ran } = play({
      tools: {
        prInfo: () => ({
          ...pr,
          base: '',
          files: [],
          paths: [],
          error: "could not fetch refs/pull/7/merge from 'origin' (Authentication failed)",
        }),
      },
    });
    expect(end).toBe('notReviewed');
    expect(r.state.outcome).toBe('failed');
    expect(ran).not.toContain('collect');
    expect(state.report).toBe(
      "Could not review: could not fetch refs/pull/7/merge from 'origin' (Authentication failed).",
    );
  });

  it('no diff says why in the report, not an empty one', () => {
    const { state, end } = play({
      agents: {
        collect: () => ({
          updates: {
            diffSummary: 'Could not retrieve the diff for PR 5952552: no access.',
            claims: '',
            files: [],
            deleted: [],
            skipped: [],
            agents: 1,
            diffRange: '',
          },
          verdict: v,
        }),
      },
    });
    expect(end).toBe('noDiff');
    expect(state.report).toBe(
      'Could not review: Could not retrieve the diff for PR 5952552: no access.',
    );
  });
});

describe('review: a version for people and a brief for an AI agent', () => {
  it('each end says how the review ended, in the brief, and the run still ends there', () => {
    const issues = play();
    expect(issues.end).toBe('issues');
    expect(String(issues.state.handoff)).toMatch(/## Status\n\nIssues found/);
    expect(String(issues.state.summary)).toMatch(/^## In short/);
    const clean = play({ agents: quiet });
    expect(clean.end).toBe('clean');
    expect(String(clean.state.handoff)).toMatch(/## Status\n\nLooks good/);
    const unverified = play({
      agents: { wholeChange: soundWhole },
      tools: { checkReview: (s) => ({ valid: [], invalid: s.newFindings }) },
    });
    expect(unverified.end).toBe('notVerified');
    expect(unverified.r.state.outcome).toBe('partial');
    expect(String(unverified.state.handoff)).toMatch(/## Status\n\nNot verified/);
  });

  it('the brief has the findings, what not to rely on, the coverage and what to do; people come first', () => {
    const { state } = play();
    const brief = String(state.handoff);
    for (const h of [
      '## Task',
      '## Instructions for the next agent',
      '## Findings (checked against the code)',
      '## Do not rely on',
      '## Coverage',
      '## The review as written',
    ])
      expect(brief).toContain(h);
    for (const f of state.findings as string[]) expect(brief).toContain(`- ${f}`);
    expect(review.result).toEqual(['summary', 'handoff']);
    const off = play({}, { plainSummary: false });
    expect(off.ran).not.toContain('explain');
    expect(off.end).toBe('issues');
  });

  it("people's version starts each finding with its path:line, so the reader can find it", () => {
    const { r, state } = play();
    expect(String(state.summary)).toContain('- `src/core/engine.ts:120` — ');
    const explain = r.state.steps.find((s) => s.nodeId === 'explain')!;
    expect(explain.attempts ?? []).toEqual([]);
    const unplaced: Agent = () => ({
      updates: {
        summary:
          '## In short\nOne problem.\n\n## What we found\n- The retry counter never goes back to zero.\n\n## What is not certain\nNothing.\n\n## How we checked\nWe read the files.',
      },
      verdict: v,
    });
    const sent = play({ agents: { explain: unplaced } });
    const back = sent.r.state.steps.find((s) => s.nodeId === 'explain')!.attempts![0]!;
    expect(back.errors.join(' ')).toMatch(
      /start the bullet for each entry of findings with its location/,
    );
    expect(back.errors.join(' ')).toContain('src/core/engine.ts:120');
    const nothing = play({
      agents: {
        ...quiet,
        explain: () => ({
          updates: {
            summary:
              '## In short\nNo problems.\n\n## What we found\nNothing to fix.\n\n## What is not certain\nNothing.\n\n## How we checked\nWe read the files.',
          },
          verdict: v,
        }),
      },
    });
    expect(nothing.r.state.steps.find((s) => s.nodeId === 'explain')!.attempts ?? []).toEqual([]);
  });
});

/** The rejection messages a step got, attempt by attempt. */
const rejections = (r: ReturnType<typeof play>['r'], node: string) =>
  (r.state.steps.find((s) => s.nodeId === node)?.attempts ?? []).map((a) => a.errors.join(' '));

/** Answers in turn: the first one, then the next on each retry. */
const inTurn = (...answers: Agent[]): Agent => {
  let n = 0;
  return (s, i) => answers[Math.min(n++, answers.length - 1)]!(s, i);
};

describe('review: every dimension, with proof it was looked at', () => {
  it('a reviewer that skips a dimension, or says ISSUES with no finding, is sent back', () => {
    const skipping: Agent = (s) => ({
      updates: {
        newFindings: [],
        reviewed: (s.files as string[]) ?? [],
        attestations: attest().filter((a) => !a.startsWith('D5 ')),
      },
      verdict: v,
    });
    const claimsIssues: Agent = (s) => ({
      updates: {
        newFindings: [],
        reviewed: (s.files as string[]) ?? [],
        attestations: attest(['PITFALLS']),
      },
      verdict: v,
    });
    const { r, end } = play({
      agents: { ...quiet, analyze: inTurn(skipping, claimsIssues, sound) },
    });
    const [first, second] = rejections(r, 'analyze');
    expect(first).toMatch(/one attestations entry per dimension, in order: D1 CORRECTNESS/);
    expect(second).toMatch(/An attestation says ISSUES: write those issues as findings/);
    expect(end).toBe('clean');
  });

  it('several parts each attest every dimension; the merged answer passes too (seen live)', () => {
    const { r, end } = play(
      { agents: { ...quiet, collect: collecting(['src/a.ts', 'src/b.ts']) } },
      { filesPerAgent: 1 },
    );
    expect(rejections(r, 'analyze')).toEqual([]);
    expect(r.state.state.attestations).toHaveLength(16);
    expect(end).toBe('clean');
    // A part that doubles one dimension and drops another is still sent back.
    const doubled = attest();
    doubled[4] = doubled[3]!;
    const bad: Agent = (s) => ({
      updates: { newFindings: [], reviewed: (s.files as string[]) ?? [], attestations: doubled },
      verdict: v,
    });
    const sent = play({ agents: { ...quiet, analyze: inTurn(bad, sound) } });
    expect(rejections(sent.r, 'analyze')[0]).toMatch(/one attestations entry per dimension/);
  });

  it('a CLEAN finding names a rule id from the catalogue', () => {
    const cleanFinding =
      (rule: string): Agent =>
      (s) => ({
        updates: {
          newFindings: [
            `src/core/engine.ts:120 — [CLEAN] [LOW] ${rule}a flag argument \`attempts += 1\``,
          ],
          reviewed: (s.files as string[]) ?? [],
          attestations: attest(['CLEAN']),
        },
        verdict: v,
      });
    const { r, state } = play({
      agents: { analyze: inTurn(cleanFinding(''), cleanFinding('[G99] '), cleanFinding('[F3] ')) },
    });
    const [none, unknown] = rejections(r, 'analyze');
    expect(none).toMatch(/CLEAN entry a rule id from the Clean Code list/);
    expect(unknown).toMatch(/Not allowed: "\[G99\]"/);
    expect(state.findings).toContain(
      'F1 src/core/engine.ts:120 — [CLEAN] [LOW] [F3] a flag argument `attempts += 1`',
    );
  });

  it('new categories (concurrency, error paths, compatibility, missing code, scope) are accepted', () => {
    const { state } = play({
      agents: {
        analyze: (s) => ({
          updates: {
            newFindings: [
              'src/core/engine.ts:120 — [CONCURRENCY] [HIGH] two workers bump it `attempts += 1`',
            ],
            reviewed: (s.files as string[]) ?? [],
            attestations: attest(['PITFALLS']),
          },
          verdict: v,
        }),
      },
    });
    expect(state.findings).toContain(
      'F1 src/core/engine.ts:120 — [CONCURRENCY] [HIGH] two workers bump it `attempts += 1`',
    );
  });

  it('a BUG the per-file review found reaches the report when the whole-change step adds nothing', () => {
    const { state, end } = play({ agents: { wholeChange: soundWhole } });
    expect(state.findings).toEqual([
      'F1 src/core/engine.ts:120 — [BUG] [HIGH] retry counter never resets `attempts += 1`',
    ]);
    expect(end).toBe('issues');
    expect(String(state.report)).toContain('[F1]');
  });
});

describe('review: the whole change, against an independent inventory', () => {
  const twoClaims: Agent = (s) => {
    const base = demo.agents!.gatherContext!(s, 0) as { updates: Record<string, unknown> };
    return {
      updates: {
        ...base.updates,
        claimList: ['C1 Retry a failed step', 'C2 Stop after three tries'],
      },
      verdict: v,
    };
  };

  it('omitting the second claim, or answering a behaviour twice, is sent back (S3)', () => {
    const omitsC2: Agent = (s) => {
      const ok = soundWhole(s, 0) as { updates: Record<string, unknown> };
      return {
        updates: { ...ok.updates, claimVerdicts: ['C1 MET — src/a.ts:1 — yes'] },
        verdict: v,
      };
    };
    const doublesB1: Agent = (s) => {
      const ok = soundWhole(s, 0) as { updates: Record<string, unknown> };
      return {
        updates: { ...ok.updates, testVerdicts: ['B1 TESTED — t:1', 'B1 TESTED — t:2'] },
        verdict: v,
      };
    };
    const { r, end } = play({
      agents: {
        ...quiet,
        gatherContext: twoClaims,
        wholeChange: inTurn(omitsC2, doublesB1, soundWhole),
      },
    });
    const [omitted, doubled] = rejections(r, 'wholeChange');
    expect(omitted).toMatch(/one claimVerdicts entry for each entry of claimList/);
    expect(doubled).toMatch(/one testVerdicts entry for each entry of behaviours/);
    expect(end).toBe('clean');
  });

  it('an adverse verdict must be a finding too; with its finding gone it still is not "clean"', () => {
    const untestedNoFinding: Agent = (s) => {
      const ok = soundWhole(s, 0) as { updates: Record<string, unknown> };
      return { updates: { ...ok.updates, testVerdicts: ['B1 UNTESTED — none'] }, verdict: v };
    };
    const sent = play({ agents: { ...quiet, wholeChange: untestedNoFinding } });
    expect(rejections(sent.r, 'wholeChange')[0]).toMatch(
      /WEAK or UNTESTED behaviour as a \[TEST\] finding/,
    );
    // The TEST finding is written, but its citation fails: the verdict still keeps it partial.
    const gone = play({
      agents: { analyze: sound },
      tools: { checkWhole: (s) => ({ valid: [], invalid: s.wholeFindings }) },
    });
    expect(gone.state.adverseVerdicts).toEqual(['B1 UNTESTED — no test runs the retry path']);
    expect(gone.end).not.toBe('clean');
    expect(gone.r.state.outcome).toBe('partial');
  });

  it('context whose citation fails is kept, and keeps the review from "Looks good" (S2)', () => {
    const { state, end } = play({
      agents: quiet,
      tools: {
        checkBehaviours: (s) => ({
          valid: [],
          invalid: (s.behaviours as string[]).map((b) => `${b} ✗ no quote`),
        }),
      },
    });
    expect(state.inventoryRejected).toEqual([
      'B1 src/core/engine.ts:120 — a failed step is tried again `attempts += 1` ✗ no quote',
    ]);
    expect(state.openItems).toEqual([
      expect.stringMatching(/^Context the review was to use whose citation did not hold: B1 /),
    ]);
    expect(end).toBe('openQuestions');
  });

  it('a change that only deletes files is still reviewed: what still uses them is judged (S8)', () => {
    const { ran, state, end } = play({
      agents: {
        collect: collecting([], [], ['src/old.ts']),
        gatherContext: () => ({
          updates: {
            claimList: ['C1 c'],
            context: [
              'src/core/engine.ts:3 — [CALLER] (for: src/old.ts) still imports the deleted module `import { old }`',
            ],
            behaviours: [],
            obligations: [
              'O1 [CALLER] src/core/engine.ts:3 — the import of src/old.ts must go `import { old }`',
            ],
          },
          verdict: v,
        }),
        wholeChange: () => ({
          updates: {
            wholeFindings: [
              'src/core/engine.ts:3 — [MISSING] [HIGH] still imports the deleted src/old.ts `import { old }`',
            ],
            claimVerdicts: ['C1 MET — src/core/engine.ts:3 — deleted'],
            testVerdicts: [],
            obligationVerdicts: ['O1 ABSENT — the import is still there'],
            related: [],
            unrelated: [],
          },
          verdict: v,
        }),
      },
    });
    expect(ran).not.toContain('noDiffReport');
    expect(ran).not.toContain('analyze');
    expect(ran).toContain('wholeChange');
    expect(state.findings).toEqual([
      'F1 src/core/engine.ts:3 — [MISSING] [HIGH] still imports the deleted src/old.ts `import { old }`',
    ]);
    expect(state.coverage).toMatch(
      /Deleted \(nothing left to read; what still uses them was checked\): src\/old\.ts/,
    );
    expect(end).toBe('issues');
  });

  it('a failed whole-change step is not hidden: the review ends not settled', () => {
    const { state, end, r } = play({
      agents: {
        ...quiet,
        wholeChange: () => ({
          updates: {
            wholeFindings: [],
            claimVerdicts: [],
            testVerdicts: [],
            obligationVerdicts: [],
            related: [],
            unrelated: [],
          },
          verdict: { ...v, outcome: 'failed', reason: 'out of time' },
        }),
      },
    });
    expect(state.openItems).toEqual([
      expect.stringMatching(/^Steps that failed.*Judge the whole change/),
    ]);
    expect(end).toBe('openQuestions');
    expect(r.state.outcome).toBe('partial');
  });
});

describe('review: the skeptic (S11)', () => {
  const disposing =
    (...words: string[]): Agent =>
    (s) => ({
      updates: {
        objections: [],
        proposedDispositions: ((s.findings as string[]) ?? []).map(
          (f, i) => `${f.split(' ')[0]} ${words[i] ?? 'KEEP'} — reason \`attempts += 1\``,
        ),
      },
      verdict: v,
    });

  it('is skipped at complexity 1 and plays from 2', () => {
    expect(play({}, { complexity: 1 }).ran).not.toContain('skeptic');
    expect(play({}, { complexity: 4 }).ran).toContain('skeptic');
    expect(play().ran).toContain('skeptic');
  });

  it('applies its dispositions: dropped findings are kept apart, downgrades change the severity', () => {
    const { state, end } = play({ agents: { skeptic: disposing('DOWNGRADE LOW', 'DROP') } });
    expect(state.findings).toEqual([
      'F1 src/core/engine.ts:120 — [BUG] [LOW] retry counter never resets `attempts += 1`',
    ]);
    expect(state.dismissed).toEqual([
      'F2 src/core/engine.ts:120 — [TEST] [MEDIUM] no test checks the retry limit `attempts += 1`',
    ]);
    expect(state.coverage).toMatch(/Dismissed by the skeptic: F2 DROP — reason/);
    expect(end).toBe('issues');
  });

  it('dropping every finding ends not settled, never "Looks good"', () => {
    const { state, end, r } = play({
      agents: { wholeChange: soundWhole, skeptic: disposing('DROP') },
    });
    expect(state.findings).toEqual([]);
    expect(state.openItems).toContain('The skeptic dismissed every finding: check the dismissals');
    expect(end).toBe('openQuestions');
    expect(r.state.outcome).toBe('partial');
  });

  it('a DROP must quote the code, and every finding gets a disposition, in order', () => {
    const noQuote: Agent = (s) => ({
      updates: {
        objections: [],
        proposedDispositions: ((s.findings as string[]) ?? []).map(
          (f) => `${f.split(' ')[0]} DROP — wrong`,
        ),
      },
      verdict: v,
    });
    const short: Agent = () => ({
      updates: { proposedDispositions: ['F1 KEEP — holds'], objections: [] },
      verdict: v,
    });
    const { r } = play({ agents: { skeptic: inTurn(noQuote, short, disposing()) } });
    const [unquoted, missing] = rejections(r, 'skeptic');
    expect(unquoted).toMatch(/Quote the code that refutes each finding you DROP/);
    expect(missing).toMatch(/one proposedDispositions entry per finding/);
  });

  it('a failed skeptic leaves the findings standing, and the review is not settled', () => {
    const { state, end } = play({
      agents: {
        skeptic: () => ({
          updates: { proposedDispositions: [], objections: [] },
          verdict: { ...v, outcome: 'failed', reason: 'x' },
        }),
      },
    });
    expect((state.findings as string[]).length).toBe(2);
    expect(end).toBe('issuesOpen');
  });
});

describe('review: intent', () => {
  it('intent and the engine scan reach the steps that judge', () => {
    for (const step of ['gatherContext', 'analyze', 'wholeChange'])
      expect(review.nodes.find((n) => n.id === step)).toMatchObject({
        reads: expect.arrayContaining(['intent']),
      });
    for (const step of ['analyze', 'wholeChange'])
      expect(review.nodes.find((n) => n.id === step)).toMatchObject({
        reads: expect.arrayContaining(['smellHints', 'maskingFlags', 'context']),
      });
    const { state } = play(
      {
        tools: {
          scanDiff: () => ({
            diff: 'd',
            smells: ['src/core/engine.ts:121 — commented-out code (C5)'],
            masking: [],
            error: '',
          }),
        },
      },
      { intent: 'Closes #12: retries stop at three' },
    );
    expect(state.smellHints).toEqual(['src/core/engine.ts:121 — commented-out code (C5)']);
    expect(String(state.handoff)).toContain('What the change is for: Closes #12');
  });
});

describe('review: what live runs taught', () => {
  it('a whole-change finding at the same place and category as one already found is not repeated', () => {
    const { state } = play({
      agents: {
        wholeChange: (s) => {
          const ok = soundWhole(s, 0) as { updates: Record<string, unknown> };
          return {
            updates: {
              ...ok.updates,
              wholeFindings: [
                'src/core/engine.ts:120 — [BUG] [HIGH] the counter is never set back `attempts += 1`',
                'src/core/engine.ts:120 — [PERF] [LOW] counted on every visit `attempts += 1`',
              ],
            },
            verdict: v,
          };
        },
      },
    });
    expect(state.findings).toEqual([
      'F1 src/core/engine.ts:120 — [BUG] [HIGH] retry counter never resets `attempts += 1`',
      'F2 src/core/engine.ts:120 — [PERF] [LOW] counted on every visit `attempts += 1`',
    ]);
  });

  it('context cites the rule or code compared with, and names the changed file it is for', () => {
    const withContext =
      (context: string[]): Agent =>
      (s) => {
        const base = demo.agents!.gatherContext!(s, 0) as { updates: Record<string, unknown> };
        return { updates: { ...base.updates, context }, verdict: v };
      };
    const untagged = withContext([
      'AGENTS.md:3 — [CONVENTION] a change needs a test `needs a test`',
    ]);
    const tagged = withContext([
      'AGENTS.md:3 — [CONVENTION] (for: src/core/engine.ts) a change needs a test `needs a test`',
    ]);
    const { r, state } = play({ agents: { ...quiet, gatherContext: inTurn(untagged, tagged) } });
    const [first] = rejections(r, 'gatherContext');
    expect(first).toMatch(/\(for: changed path\)/);
    expect(first).toMatch(/tagged "\(for: <that path>\)"/);
    expect(state.context).toEqual([
      'AGENTS.md:3 — [CONVENTION] (for: src/core/engine.ts) a change needs a test `needs a test`',
    ]);
  });

  it('the skeptic may drop a finding as a duplicate of another, without a quote', () => {
    const { r, state } = play({
      agents: {
        skeptic: () => ({
          updates: {
            proposedDispositions: ['F1 KEEP — holds', 'F2 DROP — duplicates F1'],
            objections: [],
          },
          verdict: v,
        }),
      },
    });
    expect(rejections(r, 'skeptic')).toEqual([]);
    expect(state.dismissals).toEqual(['F2 DROP — duplicates F1']);
  });
});

describe('review reuses investigate: the chase, the debate and memory', () => {
  /** A whole-change step that cannot settle the claim until research has found something. */
  const unclearUntilEvidence: Agent = (s) => {
    const ok = soundWhole(s, 0) as { updates: Record<string, unknown> };
    const settled = ((s.evidence as string[]) ?? []).length > 0;
    return {
      updates: {
        ...ok.updates,
        claimVerdicts: [
          settled ? 'C1 MET — src/a.ts:1 — research settled it' : 'C1 UNCLEAR — cannot tell',
        ],
      },
      verdict: v,
    };
  };
  const researching: Agent = () => ({
    updates: {
      queries: ['git diff HEAD~1..HEAD'],
      chaseNotes: ['src/core/engine.ts:120 — the counter is bumped once per visit `attempts += 1`'],
    },
    verdict: v,
  });

  it('an unclear claim is researched, then judged again, before the review gives up on it', () => {
    const { ran, state, end } = play({
      agents: { ...quiet, wholeChange: unclearUntilEvidence, chase: researching },
    });
    expect(ran.filter((n) => n === 'wholeChange')).toHaveLength(2);
    expect(ran).toContain('chase');
    expect(state.evidence).toEqual([
      'src/core/engine.ts:120 — the counter is bumped once per visit `attempts += 1`',
    ]);
    expect(state.claimVerdicts).toEqual(['C1 MET — src/a.ts:1 — research settled it']);
    expect(end).toBe('clean');
    // With no research round, it is said to be open.
    const none = play(
      { agents: { ...quiet, wholeChange: unclearUntilEvidence } },
      { maxChaseRounds: 0 },
    );
    expect(none.ran).not.toContain('chase');
    expect(none.end).toBe('openQuestions');
  });

  it('from pragmatistFrom, a theoretical drop is kept; it may never drop on its own', () => {
    const dropsAll: Agent = (s) => ({
      updates: {
        proposedDispositions: ((s.findings as string[]) ?? []).map(
          (f) => `${f.split(' ')[0]} DROP — maybe wrong \`attempts += 1\``,
        ),
        objections: [],
      },
      verdict: v,
    });
    const keepsF1: Agent = (s) => {
      const proposed = (s.proposedDispositions as string[]) ?? [];
      return {
        updates: {
          dispositions: proposed.map((d, i) =>
            i === 0 ? 'F1 KEEP — the challenge is theoretical: the counter does grow' : d,
          ),
          objectionTriage: [],
          realObjections: [],
        },
        verdict: v,
      };
    };
    const { ran, state } = play(
      { agents: { skeptic: dropsAll, pragmatist: keepsF1 } },
      { complexity: 3 },
    );
    expect(ran).toContain('pragmatist');
    expect(state.findings).toEqual([
      'F1 src/core/engine.ts:120 — [BUG] [HIGH] retry counter never resets `attempts += 1`',
    ]);
    expect(state.dismissed).toHaveLength(1);
    const inventing: Agent = (s) => ({
      updates: {
        dispositions: ((s.findings as string[]) ?? []).map(
          (f) => `${f.split(' ')[0]} DROP — I think so \`x y\``,
        ),
        objectionTriage: [],
        realObjections: [],
      },
      verdict: v,
    });
    const keepsAll: Agent = (s) => ({
      updates: {
        dispositions: ((s.findings as string[]) ?? []).map(
          (f) => `${f.split(' ')[0]} KEEP — holds`,
        ),
        objectionTriage: [],
        realObjections: [],
      },
      verdict: v,
    });
    const sent = play(
      {
        agents: {
          skeptic: (s) => ({
            updates: {
              proposedDispositions: ((s.findings as string[]) ?? []).map(
                (f) => `${f.split(' ')[0]} DOWNGRADE LOW — minor`,
              ),
              objections: [],
            },
            verdict: v,
          }),
          pragmatist: inTurn(inventing, keepsAll),
        },
      },
      { complexity: 3 },
    );
    expect(rejections(sent.r, 'pragmatist')[0]).toMatch(/you may only turn one into KEEP/);
  });

  it("the skeptic's objections are researched in rounds, bounded; a repeat is reported, not researched again", () => {
    const objection = 'C1 is not met: the counter never stops at three, see src/core/engine.ts:120';
    const objecting: Agent = (s) => ({
      updates: {
        proposedDispositions: ((s.findings as string[]) ?? []).map(
          (f) => `${f.split(' ')[0]} KEEP — holds`,
        ),
        objections: [objection],
      },
      verdict: v,
    });
    const { ran, state, end } = play({ agents: { skeptic: objecting, chase: researching } });
    // Round 1 researches it; the skeptic repeats it word for word: reported, not reopened.
    expect(ran.filter((n) => n === 'skeptic')).toHaveLength(2);
    expect(ran.filter((n) => n === 'chase')).toHaveLength(1);
    expect(state.debateLog).toEqual([
      'Round 1: 1 of 1 objections sent to research, 2 findings standing',
    ]);
    expect(state.unresolvedObjections).toEqual([objection]);
    expect(state.openItems).toContainEqual(
      expect.stringMatching(/^Objections the debate could not settle: C1 is not met/),
    );
    expect(end).toBe('issuesOpen');
    // An objection must say what it attacks.
    const vague: Agent = () => ({
      updates: { proposedDispositions: [], objections: ['something feels off'] },
      verdict: v,
    });
    const sent = play({ agents: { ...quiet, skeptic: inTurn(vague, objecting) } });
    expect(rejections(sent.r, 'skeptic')[0]).toMatch(/Name what each objection attacks/);
  });

  it('a second, independent reviewer plays once at complexity 4; what it finds is checked and merged', () => {
    const second: Agent = () => ({
      updates: {
        newFindings: [
          'src/core/engine.ts:120 — [BUG] [HIGH] the same issue `attempts += 1`',
          'src/core/engine.ts:118 — [ERRPATH] [MEDIUM] a thrown step is never caught `attempts += 1`',
        ],
      },
      verdict: v,
    });
    const at2 = play({ agents: { second } });
    expect(at2.ran).not.toContain('second');
    const at4 = play({ agents: { second } }, { complexity: 4 });
    expect(at4.ran.filter((n) => n === 'second')).toHaveLength(1);
    expect(at4.state.findings).toContainEqual(
      expect.stringMatching(/^F3 src\/core\/engine\.ts:118 — \[ERRPATH\]/),
    );
    expect((at4.state.findings as string[]).filter((f) => f.includes('[BUG]'))).toHaveLength(1);
  });

  it('what earlier runs learned is recalled, and the steps that judge read it as leads', () => {
    const { state } = play({
      tools: {
        recall: () => ({ facts: ['src/core/engine.ts:120 — retries are per visit'], lessons: [] }),
      },
    });
    expect(state.knownFacts).toEqual(['src/core/engine.ts:120 — retries are per visit']);
    for (const step of ['gatherContext', 'analyze', 'wholeChange', 'skeptic', 'chase', 'second']) {
      const node = review.nodes.find((n) => n.id === step) as unknown as {
        reads: string[];
        directive: string;
      };
      expect(node.reads).toContain('knownFacts');
      expect(node.directive).toContain('use them as leads to check, never as evidence');
    }
  });
});

/** A review comment with every part, for the finding with this id. */
const fullComment = (findingId: string) =>
  `${findingId} Off by one\nWhat is wrong: the loop stops before n.\nExample: sumTo(4) gives 6 today; expected 10.\nWhy it matters: every total is short.\nHow to fix: \`i <= n\`, and a test for sumTo(4).`;

describe('review comments: what is wrong, an example, why it matters, how to fix', () => {
  it('each finding gets one, in order, with every part; the brief carries them whole', () => {
    const { state, r } = play();
    expect(rejections(r, 'comment')).toEqual([]);
    expect((state.comments as string[]).map((c) => c.split(' ')[0])).toEqual(['F1', 'F2']);
    expect(state.comments as string[]).toContainEqual(
      expect.stringMatching(
        /What is wrong: [\s\S]*Example: [\s\S]*Why it matters: [\s\S]*How to fix: /,
      ),
    );
    expect(String(state.handoff)).toContain(
      '## Review comments: what is wrong, an example, why it matters, how to fix',
    );
    expect(String(state.handoff)).toContain((state.comments as string[])[0]);
  });

  it('a comment without an example, or out of order, is sent back by what it misses', () => {
    const noExample: Agent = (s) => ({
      updates: {
        comments: ((s.findings as string[]) ?? []).map((f) =>
          fullComment(f.split(' ')[0]!).replace(/Example: .*\n/, ''),
        ),
      },
      verdict: v,
    });
    const reversed: Agent = (s) => ({
      updates: {
        comments: ((s.findings as string[]) ?? [])
          .map((f) => fullComment(f.split(' ')[0]!))
          .toReversed(),
      },
      verdict: v,
    });
    const right: Agent = (s) => ({
      updates: {
        comments: ((s.findings as string[]) ?? []).map((f) => fullComment(f.split(' ')[0]!)),
      },
      verdict: v,
    });
    const { r, end } = play({ agents: { comment: inTurn(noExample, reversed, right) } });
    const [missing, order] = rejections(r, 'comment');
    expect(missing).toMatch(/"What is wrong:", "Example:", "Why it matters:", "How to fix:"/);
    expect(order).toMatch(
      /one comment per finding, starting with its id, in the order of findings/,
    );
    expect(end).toBe('issues');
  });

  it('many findings are commented in parts of three, and still one per finding, in order', () => {
    const five: Agent = (s) => ({
      updates: {
        newFindings: [1, 2, 3, 4, 5].map(
          (n) => `src/core/engine.ts:${118 + n} — [BUG] [LOW] issue ${n} \`attempts += 1\``,
        ),
        reviewed: (s.files as string[]) ?? [],
        attestations: attest(['CORRECTNESS']),
      },
      verdict: v,
    });
    const { r, state } = play({ agents: { analyze: five, wholeChange: soundWhole } });
    expect(r.state.steps.filter((x) => x.nodeId === 'comment')).toHaveLength(1);
    expect((state.comments as string[]).map((c) => c.split(' ')[0])).toEqual(
      (state.findings as string[]).map((f) => f.split(' ')[0]),
    );
    expect(state.comments).toHaveLength(5);
  });
});
