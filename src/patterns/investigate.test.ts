import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { investigate } from './index.js';

const demo = investigate.demo!;

/** Run investigate with the plan using exactly `use` (everything else skipped). */
function runWith(
  use: string[],
  approvals: DemoScript['approvals'] = demo.approvals,
  over: Partial<DemoScript> & { context?: Record<string, unknown> } = {},
) {
  const script: DemoScript = {
    ...demo,
    ...(approvals ? { approvals } : {}),
    tools: { ...demo.tools, ...over.tools },
    agents: {
      ...demo.agents,
      ...over.agents,
      plan: (s) => {
        const names = (s.sourceNames as string[]) ?? [];
        const skip = names.filter((n) => !use.includes(n));
        return {
          updates: {
            subQuestions: ['q1'],
            searchTerms: ['t'],
            useSources: use,
            skipSources: skip,
            skipReasons: skip.map(() => 'not needed for this question'),
          },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        };
      },
    },
  };
  const score = compileScore(investigate, {
    goal: 'g',
    context: { question: 'q', ...over.context },
  });
  const r = runScripted(score, script);
  return { r, ran: r.state.steps.map((s) => s.nodeId) };
}

const triaged = (r: ReturnType<typeof runWith>['r']) =>
  r.state.steps
    .filter((s) => s.nodeId === 'triage')
    .flatMap((s) => (s.updates?.triaged as string[]) ?? []);

describe('investigate adapts its evidence to the question', () => {
  it('internet question: lists and reads web pages, never touches the workspace', () => {
    const { r, ran } = runWith(['web']);
    expect(r.state.outcome).toBe('success');
    expect(ran).toEqual(expect.arrayContaining(['listPages', 'deepRead']));
    expect(ran).not.toContain('inventory');
    expect(ran).not.toContain('triage');
    expect(ran).not.toContain('designExperiments');
    expect(r.state.steps.find((s) => s.nodeId === 'deepRead')?.updates?.examined).toEqual([
      'https://en.wikipedia.org/wiki/Finite-state_machine',
    ]);
    expect(r.state.state.consulted).toEqual([]);
  });

  it('repo question: inventories and triages every file, reads the relevant ones, no web', () => {
    const { r, ran } = runWith(['workspace', 'git-history']);
    expect(ran).toEqual(expect.arrayContaining(['inventory', 'triage', 'deepRead', 'sweep']));
    expect(ran).not.toContain('listPages');
    expect(r.state.state.pages).toEqual([]);
    expect(r.state.state.consulted).toEqual(['git-history']);
  });

  it('big repo: searches first and triages only the located files, never every file', () => {
    const many = Array.from({ length: 400 }, (_, i) => `src/gen/file${i}.ts`);
    const core = ['src/core/engine.ts', 'src/core/schema.ts', 'src/core/validate.ts'];
    const inventory = () => ({ files: [...many, ...core], excluded: [] });
    const { r, ran } = runWith(['workspace'], demo.approvals, { tools: { inventory } });
    expect(r.state.outcome).toBe('success');
    expect(ran).toContain('locate');
    expect(r.state.state.repoFileCount).toBe(403);
    expect(triaged(r).toSorted()).toEqual([...(r.state.state.scopeFiles as string[])].toSorted());
    expect(r.state.state.excludedFiles).toEqual(
      expect.arrayContaining([expect.stringMatching(/did not locate were not triaged/)]),
    );
    // Asked for every file: no search, all 403 triaged.
    const all = runWith(['workspace'], demo.approvals, {
      tools: { inventory },
      context: { exhaustive: true },
    });
    expect(all.ran).not.toContain('locate');
    expect(triaged(all.r)).toHaveLength(403);
  });

  it('a located file must be a real file of the repository', () => {
    const many = Array.from({ length: 400 }, (_, i) => `src/gen/file${i}.ts`);
    let n = 0;
    const { r } = runWith(['workspace'], demo.approvals, {
      tools: { inventory: () => ({ files: many, excluded: [] }) },
      agents: {
        locate: () => ({
          updates: {
            scopeFiles: ++n === 1 ? ['src/gen/', 'src/invented.ts'] : ['src/gen/file1.ts'],
            scopeReasons: n === 1 ? ['folder', 'guess'] : ['git grep found it'],
            scopeQueries: ['git grep thing'],
          },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        }),
      },
    });
    const located = r.state.steps.find((s) => s.nodeId === 'locate')!;
    expect(JSON.stringify(located.attempts)).toMatch(/exactly as `git ls-files` prints them/);
    expect(r.state.state.scopeFiles).toEqual(['src/gen/file1.ts']);
  });

  it('performance question: designs experiments and runs them after approval', () => {
    const { r, ran } = runWith(['workspace', 'web', 'experiment']);
    expect(ran).toEqual(
      expect.arrayContaining(['designExperiments', 'allowExperiments', 'experiment']),
    );
    expect(r.state.state.ran).toHaveLength(1);
    // Recorded findings carry the id the engine gave them.
    expect((r.state.state.findings as string[]).some((f) => /^F\d+ experiment \|/.test(f))).toBe(
      true,
    );
  });

  it('skips experiments when you reject them', () => {
    const { r, ran } = runWith(['experiment'], {
      ...demo.approvals,
      allowExperiments: () => ({ approved: false }),
    });
    expect(ran).toContain('allowExperiments');
    expect(ran).not.toContain('experiment');
    expect(r.state.outcome).toBe('success');
    expect(r.state.state.ran).toEqual([]);
  });
});

describe('items that cannot be read', () => {
  // Regression: a live run failed at deepRead because a page returned HTTP 429 and the
  // AI honestly said so; the rule accepted only "read completely", so honesty failed the run.
  const script = (deepRead: NonNullable<DemoScript['agents']>[string]): DemoScript => ({
    ...demo,
    agents: { ...demo.agents, deepRead },
  });
  const verdict = {
    outcome: 'applied' as const,
    confidence: 0.6,
    shouldTerminate: false,
    reason: 'r',
  };
  const play = (s: DemoScript) =>
    runScripted(compileScore(investigate, { context: demo.context! }), s);

  it('are reported with a reason and land in the coverage, instead of failing the run', () => {
    const r = play(
      script((s) => {
        const [page, ...rest] = s.deepBatch as string[];
        return {
          updates: {
            examined: rest,
            unreadable: [page!],
            unreadableReasons: ['HTTP 429 twice; read nothing'],
            newFindings: ['x — y'],
          },
          verdict,
        };
      }),
    );
    expect(r.state.outcome).toBe('success');
    // Retried once (maxUnreadRetries), still unreadable: reported, never retried again.
    expect(r.state.state.unreadRetries).toBe(1);
    expect((r.state.state.notRead as string[]).length).toBeGreaterThan(0);
    expect((r.state.state.notReadReasons as string[])[0]).toBe('HTTP 429 twice; read nothing');
    expect(r.state.state.unreadable).toEqual([]);
  });

  it('get one more try at the end of deep reading (a rate limit may have cleared)', () => {
    const tries = new Map<string, number>();
    const r = play(
      script((s) => {
        const batch = s.deepBatch as string[];
        const url = batch.find((x) => x.startsWith('http'));
        const n = url ? (tries.get(url) ?? 0) : 0;
        if (url) tries.set(url, n + 1);
        const flaky = url && n === 0 ? [url] : [];
        return {
          updates: {
            examined: batch.filter((x) => !flaky.includes(x)),
            unreadable: flaky,
            unreadableReasons: flaky.map(() => 'HTTP 429'),
            newFindings: ['x — y'],
          },
          verdict,
        };
      }),
    );
    expect(r.state.outcome).toBe('success');
    expect([...tries.values()]).toEqual([2]);
    expect(r.state.state.notRead).toEqual([]);
    expect(r.state.state.unreadRetries).toBe(1);
    expect(r.state.steps.filter((x) => x.nodeId === 'requeueUnread')).toHaveLength(1);
  });

  it('may not be dropped silently', () => {
    const r = play(
      script((s) => ({
        updates: {
          examined: (s.deepBatch as string[]).slice(1),
          unreadable: [],
          unreadableReasons: [],
          newFindings: ['x — y'],
        },
        verdict,
      })),
    );
    expect(r.state.outcome).toBe('failed');
    expect(r.state.reason).toMatch(/Account for EVERY item of deepBatch/);
  });
});

describe('open questions', () => {
  // Regression: a live run failed at the answer because the AI reworded the remaining gaps
  // instead of copying them verbatim. The engine now adds them itself.
  it('include every remaining gap verbatim, plus the AI own wording', () => {
    const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        assess: (s) => ({
          updates: { gaps: [(s.subQuestions as string[])[0]!], confidence: 0.9 },
          verdict: v,
        }),
        answer: (s, n) => {
          const good = demo.agents!.answer!(s, n);
          return { ...good, updates: { ...good.updates, openQuestions: ['my own wording of it'] } };
        },
      },
    };
    const r = runScripted(
      compileScore(investigate, { context: demo.context!, complexity: 1 }),
      script,
    );
    expect(r.state.outcome).toBe('success');
    const gap = (r.state.state.subQuestions as string[])[0];
    expect(r.state.state.openQuestions).toEqual([gap, 'my own wording of it']);
  });
});

describe('investigate only records evidence that holds', () => {
  const play = (over: Partial<DemoScript>) => {
    const script: DemoScript = {
      ...demo,
      agents: { ...demo.agents, ...over.agents },
      tools: { ...demo.tools, ...over.tools },
    };
    const score = compileScore(investigate, { goal: 'g', context: demo.context! });
    return runScripted(score, script);
  };

  it('drops findings whose citation failed, numbers the rest, and lists the dropped', () => {
    const r = play({
      tools: {
        checkDeep: (s) => ({
          valid: (s.newFindings as string[]).slice(1),
          invalid: [`${(s.newFindings as string[])[0]} ✗ the quote is not at that line`],
        }),
      },
    });
    expect(r.state.outcome).toBe('success');
    const findings = r.state.state.findings as string[];
    const unverified = r.state.state.unverified as string[];
    expect(unverified.length).toBeGreaterThan(0);
    for (const u of unverified) {
      const original = u.split(' ✗ ')[0]!;
      expect(findings.some((f) => f.endsWith(original))).toBe(false);
    }
    // Ids are assigned in order, once each.
    expect(findings.map((f) => /^F(\d+) /.exec(f)?.[1])).toEqual(
      findings.map((_f, i) => String(i + 1)),
    );
  });

  it('rejects an answer that cites an id no finding has', () => {
    const r = play({
      agents: {
        answer: (s) => ({
          updates: {
            answer: 'It is validated in the engine [F999].',
            openQuestions: [],
            rulings: ((s.hypotheses as string[]) ?? []).map(
              (h) => `${h.split(':')[0]}: UNKNOWN — x`,
            ),
          },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        }),
      },
    });
    const rejected = r.state.events.filter(
      (e) => e.type === 'response-rejected' && e.nodeId === 'answer',
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(JSON.stringify(rejected[0])).toMatch(/using only ids that exist in findings/);
  });
});

describe('investigate always ends: research rounds are bounded', () => {
  it('worst case (gaps never close, the skeptic always objects, a hint is given): bounded chases', () => {
    const v = { outcome: 'applied' as const, confidence: 0.2, shouldTerminate: false, reason: 'r' };
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        assess: (s) => ({
          updates: { gaps: [(s.subQuestions as string[])[0]!], confidence: 0.2 },
          verdict: v,
        }),
        challenge: () => ({ updates: { objections: ['src/x.ts was never read'] }, verdict: v }),
      },
      approvals: {
        ...demo.approvals,
        clarify: () => ({ approved: true, updates: { hint: 'look harder' } }),
      },
    };
    const score = compileScore(investigate, {
      goal: 'g',
      context: { ...demo.context!, complexity: 2 },
    });
    const r = runScripted(score, script);
    expect(r.state.kind).toBe('done');
    const s = r.state.state;
    const chases = r.state.steps.filter((x) => x.nodeId === 'chase').length;
    // Gap rounds, twice (a human hint grants one more batch), plus one per debate round.
    expect(chases).toBeLessThanOrEqual(
      2 * (s.maxGapRounds as number) + (s.maxDebateRounds as number),
    );
    expect(s.debateRounds).toBe(s.maxDebateRounds);
    // Out of rounds, not out of objections: they are reported, not dropped.
    expect(s.unresolvedObjections).toEqual(['src/x.ts was never read']);
    const normal = runScripted(
      compileScore(investigate, { goal: 'g', context: demo.context! }),
      demo,
    );
    expect(normal.state.state.unresolvedObjections).toEqual([]);
  });
});
