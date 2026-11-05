import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { advance, createEngine, toPerformance } from '../core/engine.js';
import { evaluateGuard } from '../core/expr.js';
import { replayPerformance } from '../core/replay.js';
import { runScripted, scriptedResolution } from '../core/scripted.js';
import type {
  DemoResponder,
  DemoScript,
  EngineEvent,
  PreloadRecord,
  Resolution,
  NodeResult,
} from '../core/types.js';
import { buildAgentPrompt } from '../runtime/provider.js';
import { itemOf } from '../core/items.js';
import { investigate } from './index.js';
import { assessFor } from './investigate.js';

const demo = investigate.demo!;

/** investigate with each setting as set on its own (lean off): these tests check one mechanism each. */
const compileInvestigate = (opts: Parameters<typeof compileScore>[1] = {}) =>
  compileScore(investigate, { ...opts, context: { lean: false, ...opts.context } });

/** A deep-read responder that leaves `readNotes` out gets one note per batch item. */
const withNotes =
  (f: DemoResponder): DemoResponder =>
  (s, visit) => {
    const r = f(s, visit);
    if (r.updates.readNotes) return r;
    const batch = (s.deepBatch as string[]) ?? [];
    return { ...r, updates: { ...r.updates, readNotes: batch.map((x) => `${x} — read`) } };
  };

/** Run investigate with the plan using exactly `use` (everything else skipped). */
/** How many leading characters two prompts share. */
const sharedPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
};

function runWith(
  use: string[],
  approvals: DemoScript['approvals'] = demo.approvals,
  over: Partial<DemoScript> & {
    context?: Record<string, unknown>;
    parts?: string[];
    parallel?: number;
  } = {},
) {
  // web and experiment always play when on offer: a test that does not use them describes a
  // machine that does not offer them.
  const offered = (s: Readonly<Record<string, unknown>>) => {
    const all = demo.tools!.catalog!(s) as { names: string[]; descriptions: string[] };
    const keep = all.names.map((n) => !['web', 'experiment'].includes(n) || use.includes(n));
    return {
      names: all.names.filter((_, i) => keep[i]),
      descriptions: all.descriptions.filter((_, i) => keep[i]),
    };
  };
  const script: DemoScript = {
    ...demo,
    ...(approvals ? { approvals } : {}),
    tools: { ...demo.tools, catalog: offered, ...over.tools },
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
            parts: over.parts ?? [],
            agents: over.parallel ?? 4,
          },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        };
      },
    },
  };
  const score = compileInvestigate({
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
    // Every file not triaged is named: 403 minus the located ones, each listed in the coverage.
    const s = r.state.state;
    const unlocated = s.unlocatedFiles as string[];
    expect(unlocated.length + triaged(r).length).toBe(403);
    expect(unlocated.toSorted()).toEqual(
      (s.repoFiles as string[]).filter((f) => !triaged(r).includes(f)).toSorted(),
    );
    expect(s.excludedFiles).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\d+ files the search did not locate were not triaged/),
      ]),
    );
    expect(String(s.answer)).toMatch(
      /- Not located, so not triaged: src\/gen\/file\d+\.ts; .* … \(all in unlocatedFiles\)/,
    );
    // Asked for every file: no search, all 403 triaged.
    const all = runWith(['workspace'], demo.approvals, {
      tools: { inventory },
      context: { exhaustive: true },
    });
    expect(all.ran).not.toContain('locate');
    expect(triaged(all.r)).toHaveLength(403);
  });

  it('located paths are resolved by the engine, never sent back: folders, globs, the cap, what is no file', () => {
    const many = Array.from({ length: 400 }, (_, i) => `src/gen/file${i}.ts`);
    let n = 0;
    const { r } = runWith(['workspace'], demo.approvals, {
      tools: { inventory: () => ({ files: many, excluded: [] }) },
      agents: {
        locate: () => ({
          updates: {
            scopeFiles: (n++, ['./src/gen/file7.ts', 'src/invented.ts', 'src/gen/']),
            scopeReasons: ['git grep found it', 'guess'],
            scopeQueries: ['git grep thing'],
          },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        }),
      },
      context: { maxTriageFiles: 5 },
    });
    const located = r.state.steps.find((s) => s.nodeId === 'locate')!;
    // One answer: nothing about paths is sent back.
    expect(n).toBe(1);
    expect(located.attempts ?? []).toEqual([]);
    // The AI is told so up front.
    const locate = investigate.nodes.find((x) => x.id === 'locate') as { directive: string };
    expect(locate.directive).toMatch(/names no file of this repository is dropped/);
    const s = r.state.state;
    // The file, in the repository's spelling; then the folder's files; at most maxTriageFiles.
    expect(s.scopeFiles).toEqual([
      'src/gen/file7.ts',
      'src/gen/file0.ts',
      'src/gen/file1.ts',
      'src/gen/file2.ts',
      'src/gen/file3.ts',
    ]);
    expect((s.scopeReasons as string[])[0]).toBe('git grep found it');
    expect(s.scopeUnmatched).toEqual(['src/invented.ts — not a file of this repository']);
    expect(String(s.answer)).toMatch(
      /- Named by Locate but not in this repository: src\/invented\.ts — not a file/,
    );
  });

  it('performance question: designs experiments and runs them after approval', () => {
    const { r, ran } = runWith(['workspace', 'web', 'experiment']);
    expect(ran).toEqual(
      expect.arrayContaining(['designExperiments', 'allowExperiments', 'parallelExperiment']),
    );
    // Nothing timed: no experiment waits for another.
    expect(ran).not.toContain('experiment');
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
    expect(ran).not.toContain('parallelExperiment');
    expect(r.state.outcome).toBe('success');
    expect(r.state.state.ran).toEqual([]);
  });
});

describe('items that cannot be read', () => {
  // Regression: a live run failed at deepRead because a page returned HTTP 429 and the
  // AI honestly said so; the rule accepted only "read completely", so honesty failed the run.
  // These tests are about examined/unreadable: each note per item is filled in for them.
  const script = (deepRead: NonNullable<DemoScript['agents']>[string]): DemoScript => ({
    ...demo,
    agents: { ...demo.agents, deepRead: withNotes(deepRead) },
  });
  const verdict = {
    outcome: 'applied' as const,
    confidence: 0.6,
    shouldTerminate: false,
    reason: 'r',
  };
  const play = (s: DemoScript) => runScripted(compileInvestigate({ context: demo.context! }), s);

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

  it('a PDF or binary is reported, not fetched again the same way', () => {
    const seen: string[][] = [];
    const r = play(
      script((s) => {
        const batch = s.deepBatch as string[];
        seen.push(batch);
        const bad = seen.length === 1 ? batch.slice(0, 2) : [];
        return {
          updates: {
            examined: batch.filter((x) => !bad.includes(x)),
            unreadable: bad,
            unreadableReasons: bad.length ? ['binary file, nothing readable', 'HTTP 429'] : [],
            newFindings: ['x — y'],
          },
          verdict,
        };
      }),
    );
    expect(r.state.outcome).toBe('success');
    const [binary, flaky] = seen[0]!;
    const retried = seen.slice(1).flat();
    expect(retried).toContain(flaky);
    expect(retried).not.toContain(binary);
    expect(r.state.state.notRead).toContain(binary);
    const reasons = r.state.state.notReadReasons as string[];
    const at = (r.state.state.notRead as string[]).indexOf(binary!);
    expect(reasons[at]).toBe('binary file, nothing readable');
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
    // Stopped at the step that could not answer, keeping the findings so far.
    expect(r.state.outcome).toBe('partial');
    expect(r.state.reason).toMatch(/Account for EVERY item of deepBatch/);
  });
});

/** The assess answers the engine sent back. */
const assessRejections = (r: { state: { events: readonly EngineEvent[] } }) =>
  r.state.events.flatMap((e) =>
    e.type === 'response-rejected' && e.nodeId === 'assess' ? [JSON.stringify(e)] : [],
  );

describe('the gap check: one structured entry per sub-question', () => {
  const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
  const assessing = (assess: DemoResponder) =>
    runScripted(compileInvestigate({ context: demo.context! }), {
      ...demo,
      agents: { ...demo.agents, assess },
    });
  it('the engine derives the gaps from the GAP entries, not from a list the AI writes', () => {
    let seen = 0;
    const r = assessing((s, visit) => {
      seen += 1;
      const subs = s.subQuestions as string[];
      return visit === 0
        ? {
            updates: {
              assessment: subs.map((_, i) =>
                i === 1 ? 'S2: GAP — no test of the rejection path' : `S${i + 1}: ANSWERED [F1]`,
              ),
              objectionGaps: [],
              confidence: 0.95,
            },
            verdict: v,
          }
        : { updates: { ...assessFor(s, []), confidence: 0.2 }, verdict: v };
    });
    const first = r.state.steps.find((x) => x.nodeId === 'recordGaps')!;
    const subs = r.state.state.subQuestions as string[];
    const after = (key: string) => first.changes.find((c) => c.key === key)?.after;
    expect(after('gaps')).toEqual([subs[1]]);
    expect(after('gapNotes')).toEqual(['S2: GAP — no test of the rejection path']);
    // A confident assessment with a gap is still chased.
    expect(r.state.steps.map((x) => x.nodeId)).toContain('chase');
    expect(seen).toBeGreaterThan(1);
  });

  it('moving on is decided by the gaps, never by the confidence', () => {
    const asked = (gap: boolean, confidence: number) => {
      let n = 0;
      const r = runScripted(compileInvestigate({ context: demo.context! }), {
        ...demo,
        agents: {
          ...demo.agents,
          assess: (s) => ({
            updates: {
              ...assessFor(s, gap ? [(s.subQuestions as string[])[0]!] : []),
              confidence,
            },
            verdict: v,
          }),
        },
        approvals: {
          ...demo.approvals,
          clarify: () => {
            n += 1;
            return { approved: false };
          },
        },
      });
      expect(r.state.outcome).not.toBe('failure');
      return n;
    };
    // Sure of itself with a gap left: a person is still asked.
    expect(asked(true, 1)).toBe(1);
    // Unsure with no gap left: on to the answer.
    expect(asked(false, 0.05)).toBe(0);
  });

  it('sends back an entry left out, one out of order, an ANSWERED without a citation or one citing an unknown id', () => {
    for (const bad of [
      (subs: string[]) => subs.slice(1).map((_, i) => `S${i + 1}: ANSWERED [F1]`),
      (subs: string[]) => subs.map((_, i) => `S${subs.length - i}: ANSWERED [F1]`),
      (subs: string[]) => subs.map((_, i) => `S${i + 1}: ANSWERED, clearly`),
      (subs: string[]) => subs.map((_, i) => `S${i + 1}: ANSWERED [F9999]`),
    ]) {
      const r = assessing((s) => ({
        updates: { assessment: bad(s.subQuestions as string[]), objectionGaps: [], confidence: 1 },
        verdict: v,
      }));
      expect(r.state.outcome).toBe('partial');
      expect(assessRejections(r).length).toBeGreaterThan(0);
    }
  });
});

describe('gap expansion: the gaps send matching unread files to the deep read', () => {
  const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
  const expanding = (context: Record<string, unknown>, matched?: (pool: string[]) => string[]) => {
    const pools: string[][] = [];
    const words: string[][] = [];
    const r = runScripted(compileInvestigate({ context: { ...demo.context!, ...context } }), {
      ...demo,
      tools: {
        ...demo.tools,
        ...(matched
          ? {
              rankGaps: (s) => {
                const pool = s.expandPool as string[];
                pools.push(pool);
                words.push(s.gapNotes as string[]);
                return { ranked: pool, matched: matched(pool) };
              },
            }
          : {}),
      },
      // A gap that never closes: expansion and the chase run to their caps.
      agents: {
        ...demo.agents,
        assess: (s) => ({
          updates: { ...assessFor(s, [(s.subQuestions as string[])[0]!]), confidence: 1 },
          verdict: v,
        }),
      },
    });
    const deep = (from: number) =>
      r.state.steps
        .filter((x) => x.nodeId === 'deepRead' && x.step > from)
        .flatMap((x) => x.input?.deepBatch as string[]);
    return { r, s: r.state.state, pools, words, deep };
  };

  it('ranks only unread files, queues the matches under a round counter, then re-assesses', () => {
    const { r, s, pools, words, deep } = expanding({}, (pool) =>
      pool.filter((f) => f.endsWith('cli.ts')),
    );
    expect(pools[0]).toEqual(['README.md', 'src/cli.ts']);
    // Round 2 ranks what is still unread: cli.ts was read in round 1.
    expect(pools[1]).toEqual(['README.md']);
    expect(s.expandRounds).toBe(2);
    expect(s.expandedFiles).toEqual(['src/cli.ts']);
    const ranked = r.state.steps.find((x) => x.nodeId === 'rankGaps')!;
    expect(deep(ranked.step)).toContain('src/cli.ts');
    // Its words are the gap notes, not the question.
    expect(words[0]).toEqual([expect.stringMatching(/^S1: GAP/)]);
    const node = compileInvestigate({ context: demo.context! }).nodes.find(
      (n) => n.id === 'rankGaps',
    );
    expect(node).toMatchObject({
      tool: 'repo.rank',
      inputs: { paths: 'expandPool', subQuestions: 'gapNotes', searchTerms: 'objectionGaps' },
    });
    const after = r.state.steps.filter((x) => x.step > ranked.step).map((x) => x.nodeId);
    expect(after.indexOf('assess')).toBeLessThan(after.indexOf('chase'));
    expect(after.indexOf('assess')).toBeGreaterThan(after.indexOf('deepRead'));
    expect(r.state.outcome).not.toBe('failure');
  });

  it('is capped: at most expandWave files a round, at most maxExpandRounds rounds; 0 turns it off', () => {
    const wave = expanding({ expandWave: 1 }, (pool) => pool);
    expect(wave.s.expandedFiles).toEqual(['README.md', 'src/cli.ts']);
    const once = expanding({ maxExpandRounds: 1 }, (pool) => pool);
    expect(once.pools).toHaveLength(1);
    expect(once.s.expandedFiles).toEqual(['README.md', 'src/cli.ts']);
    const off = expanding({ maxExpandRounds: 0 }, (pool) => pool);
    expect(off.pools).toEqual([]);
    expect(off.r.state.steps.map((x) => x.nodeId)).not.toContain('rankGaps');
  });

  it('no match: straight on to the chase, nothing queued', () => {
    const { r, s } = expanding({}, () => []);
    expect(s.expandedFiles).toEqual([]);
    const ran = r.state.steps.map((x) => x.nodeId);
    expect(ran.indexOf('chase')).toBeGreaterThan(ran.indexOf('rankGaps'));
  });
});

describe('narrowed read (opt-in)', () => {
  it('triages every matched file plus narrowBudget more; each file left unread is named', () => {
    const { r } = runWith(['workspace'], demo.approvals, {
      context: { narrowRead: true, narrowBudget: 1 },
    });
    const s = r.state.state;
    // The demo search matches engine, schema and validate; README is next in rank, then cli.ts.
    expect(triaged(r).toSorted()).toEqual([
      'README.md',
      'src/core/engine.ts',
      'src/core/schema.ts',
      'src/core/validate.ts',
    ]);
    expect(s.narrowedOut).toEqual(['src/cli.ts']);
    expect(s.excludedFiles).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^1 files were left unread by the narrowed read/),
      ]),
    );
    expect(String(s.answer)).toContain('- Left unread by the narrowed read (opt-in): src/cli.ts');
  });

  it('applies only where every file would be triaged: Locate narrows a bigger repository', () => {
    // Above maxTriageFiles the queue is Locate's, with or without narrowRead.
    const located = (narrowRead: boolean) =>
      runWith(['workspace'], demo.approvals, {
        context: { maxTriageFiles: 3, narrowRead, narrowBudget: 0 },
      }).r;
    const on = located(true);
    expect(on.state.steps.map((x) => x.nodeId)).toContain('locate');
    expect(triaged(on).toSorted()).toEqual(triaged(located(false)).toSorted());
    expect(on.state.state.narrowedOut).toEqual([]);
    expect(String(on.state.state.answer)).not.toContain('narrowed read');
    // exhaustive triages every file, so narrowRead narrows it.
    const all = runWith(['workspace'], demo.approvals, {
      context: { maxTriageFiles: 3, exhaustive: true, narrowRead: true, narrowBudget: 0 },
    }).r;
    expect(all.state.state.narrowedOut).toEqual(['README.md', 'src/cli.ts']);
  });

  it('off (the default): every file is triaged, and the coverage has no such line', () => {
    const { r } = runWith(['workspace']);
    expect(triaged(r)).toHaveLength(5);
    expect(r.state.state.narrowedOut).toEqual([]);
    expect(String(r.state.state.answer)).not.toContain('narrowed read');
  });

  it('a gap that brings a narrowed-out file in reads it, and it is no longer listed as unread', () => {
    const r = runScripted(
      compileInvestigate({
        context: { ...demo.context!, narrowRead: true, narrowBudget: 1 },
      }),
      demo,
    );
    expect(r.state.state.expandedFiles).toEqual(['src/cli.ts']);
    expect(r.state.state.narrowedOut).toEqual([]);
  });
});

describe('what the skeptic and the gap research see', () => {
  it('the skeptic reads every sub-answer; gap research reads the sub-questions too', () => {
    const score = compileInvestigate({ context: demo.context! });
    const reads = (id: string) => {
      const n = score.nodes.find((x) => x.id === id);
      return n?.kind === 'agent' ? n.reads : [];
    };
    // A sub-answer new evidence contradicts can be named, so keepUnchallenged cannot freeze it.
    expect(reads('challenge')).toContain('subAnswers');
    // With gapAimed the gaps are notes; the questions they belong to stay in view.
    expect(reads('chase')).toEqual(expect.arrayContaining(['subQuestions', 'chaseGaps']));
  });

  it('the support judge reads each quote with the lines around it', () => {
    const r = runScripted(
      compileInvestigate({ context: { ...demo.context!, supportJudge: 'shadow' } }),
      demo,
    );
    const order = r.state.steps.map((x) => x.nodeId);
    expect(order.indexOf('judgeContext')).toBeGreaterThan(order.indexOf('takeJudgeItems'));
    expect(order.indexOf('judgeContext')).toBeLessThan(order.indexOf('judgeSupport'));
    const node = compileInvestigate({ context: demo.context! }).nodes.find(
      (n) => n.id === 'judgeContext',
    );
    expect(node).toMatchObject({
      tool: 'evidence.context',
      inputs: { findings: 'judgeItems' },
      output: { items: 'judgeItems' },
    });
  });
});

describe('gap-aimed research (a pilot, off by default)', () => {
  const chased = (context: Record<string, unknown>) => {
    const r = runScripted(
      compileInvestigate({
        context: { ...demo.context!, maxExpandRounds: 0, ...context },
      }),
      demo,
    );
    const rounds = r.state.steps
      .filter((x) => x.nodeId === 'chase')
      .map((x) => x.input?.chaseGaps as string[]);
    return Object.assign(rounds, { subs: r.state.state.subQuestions as string[] });
  };

  it('off: the research gets the gaps, whole sub-questions', () => {
    const rounds = chased({});
    expect(rounds[0]).toEqual([rounds.subs[1]]);
  });

  it('on: what the gap check says is missing; objections sent back stay as they are', () => {
    const rounds = chased({ gapAimed: true });
    expect(rounds[0]).toEqual([expect.stringMatching(/^S2: GAP — /)]);
    // The demo's skeptic objects once: that round researches the objection itself.
    expect(rounds.at(-1)).toEqual([expect.stringMatching(/^S[0-9]+: (?!GAP)/)]);
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
          updates: { ...assessFor(s, [(s.subQuestions as string[])[0]!]), confidence: 0.9 },
          verdict: v,
        }),
        answer: (s, n) => {
          const good = demo.agents!.answer!(s, n);
          return { ...good, updates: { ...good.updates, openQuestions: ['my own wording of it'] } };
        },
      },
    };
    const r = runScripted(compileInvestigate({ context: demo.context!, complexity: 1 }), script);
    // An open sub-question is an open doubt: the outcome says so, not only the text.
    expect(r.state.outcome).toBe('partial');
    expect(r.state.state.doubts).toEqual([
      expect.stringMatching(/^Sub-questions the findings do not answer: S1: OPEN — /),
    ]);
    const gap = (r.state.state.subQuestions as string[])[0];
    // The gap verbatim, the AI's own wording, and the sub-answer that says it is open.
    expect(r.state.state.openQuestions).toEqual([
      gap,
      'my own wording of it',
      expect.stringMatching(/^S1: OPEN — /),
    ]);
  });
});

describe('investigate only records evidence that holds', () => {
  const play = (over: Partial<DemoScript>) => {
    const script: DemoScript = {
      ...demo,
      agents: { ...demo.agents, ...over.agents },
      tools: { ...demo.tools, ...over.tools },
    };
    const score = compileInvestigate({ goal: 'g', context: demo.context! });
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
            subAnswers: ((s.subQuestions as string[]) ?? []).map((_, i) => `S${i + 1}: OPEN — x`),
            rulings: ((s.hypotheses as string[]) ?? []).map(
              (h) => `${h.split(':')[0]}: UNKNOWN — x`,
            ),
            objectionResolutions: [],
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
          updates: { ...assessFor(s, [(s.subQuestions as string[])[0]!]), confidence: 0.2 },
          verdict: v,
        }),
        challenge: (_s, visit) => ({
          updates: { objections: [`S1: src/x.ts was never read (F1, round ${visit})`] },
          verdict: v,
        }),
      },
      approvals: {
        ...demo.approvals,
        clarify: () => ({ approved: true, updates: { hint: 'look harder' } }),
      },
    };
    const score = compileInvestigate({
      goal: 'g',
      context: { ...demo.context!, complexity: 2 },
    });
    const r = runScripted(score, script);
    expect(r.state.kind).toBe('done');
    const s = r.state.state;
    const chases = r.state.steps.filter((x) => x.nodeId === 'chase').length;
    // Gap rounds, twice (a human hint grants one more batch), and a batch per debate round.
    const gapRounds = s.maxGapRounds as number;
    expect(chases).toBeLessThanOrEqual(2 * gapRounds + (s.maxDebateRounds as number) * gapRounds);
    expect(s.debateRounds).toBe(s.maxDebateRounds);
    // Out of rounds, not out of objections: they are reported, not dropped.
    expect(s.unresolvedObjections).toEqual([
      `S1: src/x.ts was never read (F1, round ${s.maxDebateRounds})`,
    ]);
    const normal = runScripted(compileInvestigate({ goal: 'g', context: demo.context! }), demo);
    expect(normal.state.state.unresolvedObjections).toEqual([]);
    // One budget for the whole run, whatever resets the per-round one.
    expect(chases).toBe(s.chaseRounds);
    expect(chases).toBeLessThanOrEqual(s.maxChaseRounds as number);
    const capped = runScripted(
      compileInvestigate({
        goal: 'g',
        context: { ...demo.context!, complexity: 2, maxChaseRounds: 3 },
      }),
      script,
    );
    expect(capped.state.kind).toBe('done');
    expect(capped.state.steps.filter((x) => x.nodeId === 'chase')).toHaveLength(3);
    expect(capped.state.state.chaseRounds).toBe(3);
    // Out of research, the objections still reach the answer, which must resolve each one.
    const lastAnswer = capped.state.steps.findLast((x) => x.nodeId === 'answer')!;
    expect(lastAnswer.input?.realObjections).not.toEqual([]);
  });

  it('gapsPerChase 1 gives each gap its own sub-agent', () => {
    const v = { outcome: 'applied' as const, confidence: 0.6, shouldTerminate: false, reason: 'r' };
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        assess: (s, visit) => ({
          updates: {
            ...assessFor(s, visit === 0 ? ((s.subQuestions as string[]) ?? []) : []),
            confidence: 0.9,
          },
          verdict: v,
        }),
      },
    };
    const r = runScripted(
      compileInvestigate({
        goal: 'g',
        // No gap expansion: the chase gets the gaps.
        context: { ...demo.context!, gapsPerChase: 1, maxExpandRounds: 0 },
      }),
      script,
    );
    expect(r.state.outcome).toBe('success');
    const pause = r.state.events.flatMap((e) =>
      e.type === 'paused' && e.pause.kind === 'agent' && e.pause.nodeId === 'chase'
        ? [e.pause]
        : [],
    )[0]!;
    const gaps = r.state.state.subQuestions as string[];
    expect(gaps.length).toBeGreaterThan(1);
    expect(pause.parts?.map((p) => p.chaseGaps)).toEqual(gaps.map((g) => [g]));
  });

  it('with one sub-agent per gap, a gap researched by nobody is sent back, even beside full ones', () => {
    const v = { outcome: 'applied' as const, confidence: 0.6, shouldTerminate: false, reason: 'r' };
    const r = runScripted(
      compileInvestigate({
        goal: 'g',
        context: { ...demo.context!, gapsPerChase: 1, maxExpandRounds: 0 },
      }),
      {
        ...demo,
        agents: {
          ...demo.agents,
          assess: (s, visit) => ({
            updates: {
              ...assessFor(s, visit === 0 ? ((s.subQuestions as string[]) ?? []) : []),
              confidence: 0.9,
            },
            verdict: v,
          }),
          // The first gap's sub-agent finds nothing and says so with a well-formed, empty answer.
          chase: (s, visit) => {
            const first = (s.chaseGaps as string[])[0] === (s.subQuestions as string[])[0];
            return first
              ? { updates: { queries: ['grep x'], newFindings: [] }, verdict: v }
              : demo.agents!.chase!(s, visit);
          },
        },
      },
    );
    const rejected = r.state.events.flatMap((e) =>
      e.type === 'response-rejected' && e.nodeId === 'chase' ? e.errors : [],
    );
    expect(rejected[0]).toMatch(/^part 1 of \d+: Report a finding for every gap/);
  });
});

describe('investigate answers several subjects side by side', () => {
  const ALGOS = ['fix', 'refactor', 'review'];
  it('the parts share one prompt up to their own subject, which comes last (the cache reuses the rest)', () => {
    const { r } = runWith(['workspace'], demo.approvals, { parts: ALGOS });
    const pause = r.state.events.flatMap((e) =>
      e.type === 'paused' && e.pause.kind === 'agent' && e.pause.nodeId === 'answerParts'
        ? [e.pause]
        : [],
    )[0]!;
    expect(pause.warmFirst).toBe(true);
    // As the driver plays a part: the step's pause with the part's input.
    const { parts, partsDone: _done, ...single } = pause;
    const prompts = parts!.map((input) => buildAgentPrompt({ ...single, input }));
    const common = sharedPrefix(prompts[0]!, prompts[1]!);
    const tail = prompts[0]!.slice(common);
    // Everything up to the part's own subject is shared, the findings included.
    expect(prompts[0]!.indexOf('"findingsBrief"')).toBeLessThan(common);
    expect(prompts[0]!.lastIndexOf('"parts"')).toBeLessThan(common);
    expect(tail.length).toBeLessThan(200);
  });

  it('gathers evidence once, answers each part in its own call, and attaches every part', () => {
    const { r, ran } = runWith(['workspace'], demo.approvals, { parts: ALGOS });
    expect(r.state.outcome).toBe('success');
    // Evidence is gathered once, not once per part.
    expect(ran.filter((n) => n === 'plan')).toHaveLength(1);
    const step = r.state.steps.find((st) => st.nodeId === 'answerParts')!;
    expect(step.input?.parts).toEqual(ALGOS);
    expect(r.state.state.partAnswers).toEqual(ALGOS.map((a) => expect.stringMatching(`^## ${a}`)));
    // The summary comes first; every part follows it verbatim, in order.
    const answer = String(r.state.state.answer);
    const at = ALGOS.map((a) => answer.indexOf(`## ${a}\n`));
    expect(at.every((i) => i > answer.indexOf('---'))).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
  });

  it('one subject is a single answer, as before', () => {
    const { r, ran } = runWith(['workspace']);
    expect(ran).not.toContain('answerParts');
    expect(String(r.state.state.answer)).not.toContain('---');
  });

  it('rejects a synthesis or summary part: the overall answer is the synthesis', () => {
    for (const extra of ['synthesis', 'Summary', 'Overall recommendations', '5. Conclusion:']) {
      const { r } = runWith(['workspace'], demo.approvals, { parts: [...ALGOS, extra] });
      const plan = r.state.steps.find((st) => st.nodeId === 'plan');
      expect(JSON.stringify(plan?.attempts ?? r.state.pause), extra).toMatch(
        /leave out a synthesis, summary, overview or conclusion part/,
      );
    }
    // A subject that merely contains or starts with such a word is fine.
    for (const parts of [
      ['token summary cache', 'speed'],
      ['summarize.py', 'parse.py', 'fetch.py'],
      ['the Summarizer', 'Synthesizer', 'Overview page'],
    ]) {
      const ok = runWith(['workspace'], demo.approvals, { parts });
      expect(ok.r.state.outcome, parts.join()).toBe('success');
    }
  });

  it('rejects a plan with exactly one part', () => {
    const { r } = runWith(['workspace'], demo.approvals, { parts: ['fix'] });
    const plan = r.state.steps.find((st) => st.nodeId === 'plan');
    expect(JSON.stringify(plan?.attempts ?? r.state.pause)).toMatch(/2 to 8 independent subjects/);
    expect(r.state.outcome).not.toBe('success');
  });
});

describe('investigate sizes its parallel work from the plan', () => {
  it('the plan picks how many sub-agents read at once (at most 6)', () => {
    const { r } = runWith(['workspace'], demo.approvals, { parallel: 2 });
    expect(r.state.outcome).toBe('success');
    expect(r.state.state).toMatchObject({ agents: 2, batchWave: 60, deepWave: 24 });
    const bad = runWith(['workspace'], demo.approvals, { parallel: 9 }).r;
    const plan = bad.state.steps.find((st) => st.nodeId === 'plan');
    expect(JSON.stringify(plan?.attempts ?? bad.state.pause)).toMatch(/from 1 to 6/);
  });
});

describe('investigate hands on its evidence', () => {
  it('the result carries the findings the answer cites, with their ids', () => {
    const { r } = runWith(['workspace']);
    const cited = r.state.state.citedFindings as string[];
    expect(cited.length).toBeGreaterThan(0);
    expect(
      cited.every(
        (f) => /^F\d+ /.test(f) && String(r.state.state.answer).includes(`[${f.split(' ')[0]}]`),
      ),
    ).toBe(true);
    // The AI version carries them, each with its id, as the chained run reads it.
    expect(investigate.result).toEqual(['summary', 'handoff']);
    const handoff = String(r.state.state.handoff);
    for (const f of cited) expect(handoff).toContain(`- ${f}`);
  });

  it('two versions: a plain one for people first, then a complete one for an AI agent', () => {
    const { r } = runWith(['workspace']);
    const s = r.state.state;
    const handoff = String(s.handoff);
    // The AI version: every section, the full answer, and what to do with it.
    for (const h of [
      '## Task',
      '## Status',
      '## Sub-questions and their answers',
      '## Hypotheses and rulings',
      '## Answer (with what was and was not investigated)',
      '## Evidence: the findings the answer cites',
      '## Do not rely on: findings that could not be verified',
      '## Still open',
      '## Instructions for the next agent',
    ])
      expect(handoff).toContain(h);
    expect(handoff).toContain(String(s.answer));
    expect(handoff).toContain(`Question: ${String(s.question)}`);
    // The plain one: short sentences, no ids.
    const summary = String(s.summary);
    expect(summary).toMatch(/^## In short/);
    expect(summary).not.toMatch(/\[F\d+\]/);
    // Off: one model call fewer, and the AI version alone.
    const off = runWith(['workspace'], demo.approvals, { context: { plainSummary: false } });
    expect(off.ran).not.toContain('explain');
    expect(off.r.state.state.summary).toBe('');
    expect(String(off.r.state.state.handoff)).toContain('## Instructions for the next agent');
  });

  it('the plain version is sent back with each sentence that is too long, and with any id', () => {
    let n = 0;
    const long =
      'This sentence is far too long for a reader who does not know the project, because it goes on and on without a single stop in it.';
    const { r } = runWith(['workspace'], demo.approvals, {
      agents: {
        explain: (st) => {
          n += 1;
          const ok = demo.agents!.explain!(st, 0) as unknown as NodeResult;
          const summary = String(ok.updates.summary);
          return n === 1 ? { ...ok, updates: { summary: `${summary}\n\n${long} See [F1].` } } : ok;
        },
      },
    });
    const step = r.state.steps.find((x) => x.nodeId === 'explain')!;
    const errors = step.attempts![0]!.errors.join(' ');
    expect(errors).toContain(`Found: "${long.slice(0, 60)}`);
    expect(errors).toMatch(/Leave out citation ids like \[F12\]/);
    expect(r.state.outcome).toBe('success');
  });
});

describe('investigate asks for a hint once', () => {
  it('an empty hint stays empty, is not asked again, and the run still answers', () => {
    const v = { outcome: 'applied' as const, confidence: 0.2, shouldTerminate: false, reason: 'r' };
    let asked = 0;
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        assess: (s) => ({
          updates: { ...assessFor(s, [(s.subQuestions as string[])[0]!]), confidence: 0.2 },
          verdict: v,
        }),
      },
      approvals: {
        ...demo.approvals,
        clarify: () => {
          asked += 1;
          return { approved: true, updates: { hint: '' } };
        },
      },
    };
    const r = runScripted(
      compileInvestigate({ goal: 'g', context: { ...demo.context!, complexity: 1 } }),
      script,
    );
    expect(asked).toBe(1);
    expect(r.state.state).toMatchObject({ hint: '', hintAsked: true });
    expect(r.state.steps.some((st) => st.nodeId === 'answer')).toBe(true);
    // Every evidence step reads the hint.
    for (const id of ['triage', 'deepRead', 'sweep', 'assess', 'answer'])
      expect(
        (investigate.nodes.find((n) => n.id === id) as unknown as { reads: string[] }).reads,
      ).toContain('hint');
  });
});

describe('investigate always tries: the web and targeted experiments', () => {
  /** The demo, with the plan's skips and the experiments it designs replaced. */
  const play = (skip: string[], experiments?: string[][]) => {
    let designs = 0;
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        plan: (st) => {
          const base = demo.agents!.plan!(st, 0) as { updates: Record<string, unknown> };
          const names = (st.sourceNames as string[]) ?? [];
          return {
            updates: {
              ...base.updates,
              useSources: names.filter((n) => !skip.includes(n)),
              skipSources: skip,
              skipReasons: skip.map(() => 'not needed'),
            },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          };
        },
        ...(experiments
          ? {
              designExperiments: () => ({
                updates: {
                  experiments: experiments[Math.min(designs++, experiments.length - 1)]!,
                  timedExperiments: [],
                },
                verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
              }),
            }
          : {}),
      },
    };
    return runScripted(compileInvestigate({ goal: 'g', context: { question: 'q' } }), script);
  };
  const rejections = (r: ReturnType<typeof play>, node: string) =>
    (r.state.steps.find((x) => x.nodeId === node)?.attempts ?? []).map((a) => a.errors.join(' '));

  it('skipping the web or experiments when they are on offer is sent back', () => {
    const noWeb = play(['web', 'prior-runs']);
    expect(rejections(noWeb, 'plan')[0]).toMatch(/Always use web/);
    const noTries = play(['experiment', 'prior-runs']);
    expect(rejections(noTries, 'plan')[0]).toMatch(
      /Always use experiment: test the hypotheses with small, targeted runs/,
    );
  });

  it('an experiment that runs the whole suite is sent back; one test, repeated, is not', () => {
    const r = play(
      ['prior-runs'],
      [
        ['npm test — whether it is flaky — count failures'],
        ['cd packages/ui && npx playwright test --retries=0 — flaky? — count'],
        [
          'npx playwright test e2e/drag.spec.ts --repeat-each=30 --retries=0 — whether the drag test is flaky — failures out of 30',
          'npx jest --testPathPattern=lookup -t "returns unknown" — the fallback — passes',
        ],
      ],
    );
    const [suite, flagsOnly] = rejections(r, 'designExperiments');
    expect(suite).toMatch(/never the whole suite/);
    expect(flagsOnly).toMatch(/never the whole suite/);
    expect(rejections(r, 'designExperiments')).toHaveLength(2);
    expect(r.state.steps.some((x) => x.nodeId === 'parallelExperiment')).toBe(true);
  });

  it('experiments play in a throwaway copy of the workspace', () => {
    for (const id of ['experiment', 'parallelExperiment'])
      expect(investigate.nodes.find((n) => n.id === id)).toMatchObject({ sandbox: true });
  });
});

describe('investigate says how to verify what is still open', () => {
  /** The demo, its answer leaving two questions open, and the verification answers given in turn. */
  const play = (...answers: ((s: Readonly<Record<string, unknown>>) => string[])[]) => {
    let n = 0;
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        answer: (st, i) => {
          const base = demo.agents!.answer!(st, i) as { updates: Record<string, unknown> };
          return {
            updates: {
              ...base.updates,
              openQuestions: [
                'What is the real flake rate per package?',
                'Which branch policies apply?',
              ],
            },
            verdict: { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'r' },
          };
        },
        planVerification: (st) => ({
          updates: { verification: answers[Math.min(n++, answers.length - 1)]!(st) },
          verdict: { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'r' },
        }),
      },
    };
    return runScripted(compileInvestigate({ goal: 'g', context: { question: 'q' } }), script);
  };
  const right = (st: Readonly<Record<string, unknown>>) =>
    ((st.openQuestions as string[]) ?? []).map((q, i) =>
      i === 0
        ? `V${i + 1} QUERY — kusto_query cluster bohemiahealth, database Health: TestHealthV2 | where Timestamp > ago(30d) | summarize retried=countif(Retried) by Package — the flake rate per package`
        : `V${i + 1} QUERY — az repos policy list --branch master -o table — which policies apply`,
    );

  it('one line per open item, in order, each a read, a query or a run, in the brief', () => {
    const r = play(right);
    const open = r.state.state.openQuestions as string[];
    expect(open.length).toBeGreaterThanOrEqual(2);
    expect(r.state.state.verification).toHaveLength(open.length);
    expect(String(r.state.state.handoff)).toContain('## How to verify what is still open');
    expect(String(r.state.state.handoff)).toContain('V1 QUERY — kusto_query cluster bohemiahealth');
  });

  it('a missing line, or one that is not a read, a query or a run, is sent back', () => {
    const short = (st: Readonly<Record<string, unknown>>) => right(st).slice(1);
    const vague = (st: Readonly<Record<string, unknown>>) =>
      right(st).map((x, i) => (i === 0 ? 'V1 look into it' : x));
    const r = play(short, vague, right);
    const errors = (r.state.steps.find((x) => x.nodeId === 'planVerification')?.attempts ?? []).map(
      (a) => a.errors.join(' '),
    );
    expect(errors[0]).toMatch(/one verification entry per entry of openQuestions/);
    expect(errors[1]).toMatch(/READ\|QUERY\|RUN — the exact files, query or command/);
  });
});

describe('investigate experiments', () => {
  it('timed experiments run one at a time after the others ran side by side', () => {
    const exps = ['a — time the cold start', 'b — does it crash?', 'c — does it leak?'];
    const { r, ran } = runWith(['experiment'], demo.approvals, {
      agents: {
        ...demo.agents,
        designExperiments: () => ({
          updates: { experiments: exps, timedExperiments: [exps[0]!] },
          verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
        }),
      },
      context: { agents: 2 },
    });
    const side = r.state.steps.find((st) => st.nodeId === 'parallelExperiment')!;
    expect(side.input?.parallelExperiments).toEqual([exps[1], exps[2]]);
    expect(ran.filter((n) => n === 'experiment')).toHaveLength(1);
    expect(ran.indexOf('parallelExperiment')).toBeLessThan(ran.indexOf('experiment'));
    expect((r.state.state.ran as string[]).toSorted()).toEqual([...exps].toSorted());
  });
});

describe('investigate searches sources side by side', () => {
  it('each round takes as many sources as there are sub-agents', () => {
    const { r } = runWith(['git-history', 'prior-runs'], demo.approvals, { parallel: 2 });
    const sweeps = r.state.steps.filter((st) => st.nodeId === 'sweep');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.input?.currentSources).toEqual(['git-history', 'prior-runs']);
    expect(r.state.state.consulted).toEqual(['git-history', 'prior-runs']);
  });
});

describe('investigate remembers what its answer used', () => {
  it('checks do not remember as they go; a settled answer remembers its cited findings', () => {
    const score = compileInvestigate({ goal: 'g', context: demo.context! });
    const checks = score.nodes.filter((n) => n.kind === 'tool' && n.tool === 'evidence.check');
    expect(checks.length).toBeGreaterThan(5);
    for (const c of checks) expect(c).toMatchObject({ args: { remember: false } });
    const { r } = runWith(['workspace']);
    expect(r.state.outcome).toBe('success');
    const node = score.nodes.find((n) => n.id === 'rememberCited');
    expect(node).toMatchObject({ tool: 'memory.facts', inputs: { findings: 'factsToKeep' } });
    expect(r.state.state.factsToKeep).toEqual(r.state.state.citedFindings);
    const cited = (r.state.state.citedFindings as string[]).length;
    expect(cited).toBeGreaterThan(0);
    expect(r.state.state.factsSaved).toBe(cited);
  });
});

describe('investigate keeps a tally per hypothesis', () => {
  it('the engine counts [H# for/against] tags after each merge; no hypothesis is dropped', () => {
    const { r } = runWith(['workspace']);
    const s = r.state.state;
    const status = s.hypothesisStatus as string[];
    expect(status).toHaveLength((s.hypotheses as string[]).length);
    const tagged = (s.findings as string[]).filter((f) =>
      /\[[^\]]*H1 (for|against)/i.test(f),
    ).length;
    const [, f, a] = /^H1: (\d+) for, (\d+) against/.exec(status[0]!)!;
    expect(Number(f) + Number(a)).toBe(tagged);
    const deep = r.state.steps.find((x) => x.nodeId === 'deepRead');
    // The tally as it stood when the deep read began, one line per hypothesis.
    expect(deep?.input?.leadStatus).toHaveLength((s.hypotheses as string[]).length);
    expect(deep?.input?.leadHypotheses).toEqual(s.hypotheses);
  });

  it('readerHypotheses off (an ablation): readers get none and may not tag; the answer still rules on each', () => {
    let tagged = 0;
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        deepRead: (s, v) => {
          const good = demo.agents!.deepRead!(s, v);
          // The first answer tags anyway: it is sent back.
          if (tagged++ > 0) return good;
          const findings = (good.updates.newFindings as string[]).map((f) => `${f} [H1 for]`);
          return { ...good, updates: { ...good.updates, newFindings: findings } };
        },
      },
    };
    const r = runScripted(
      compileInvestigate({
        goal: 'g',
        context: { ...demo.context!, readerHypotheses: false },
      }),
      script,
    );
    const s = r.state.state;
    for (const node of ['triage', 'deepRead', 'sweep', 'chase']) {
      const step = r.state.steps.find((x) => x.nodeId === node);
      if (!step) continue;
      expect(step.input?.leadHypotheses, node).toEqual([]);
      expect(step.input?.leadStatus, node).toEqual([]);
      expect(step.input, node).not.toHaveProperty('hypotheses');
    }
    const rejected = r.state.events.flatMap((e) =>
      e.type === 'response-rejected' && e.nodeId === 'deepRead' ? e.errors : [],
    );
    expect(rejected.join()).toMatch(/do not tag findings/);
    expect(r.state.outcome).toBe('success');
    expect((s.rulings as string[]).length).toBe((s.hypotheses as string[]).length);
  });
});

describe('investigate coverage', () => {
  it('the engine writes the coverage section from its record', () => {
    const { r } = runWith(['workspace']);
    const answer = String(r.state.state.answer);
    expect(answer).toMatch(
      /\n## Coverage\n\n- Files not triaged: .+\n- Not located, so not triaged: none\n- Pages read: .+\n- Experiments run: none\n- Read because a gap named them: none\n/,
    );
    expect(answer.match(/## Coverage/g)).toHaveLength(1);
    const findings = r.state.state.findings as string[];
    const onTrust = findings.filter((f) => !/[\w@.-]+\.[A-Za-z0-9]+:\d/.test(f)).length;
    expect(answer).toContain(
      `- Findings not checked against a file (web pages, other sources): ${onTrust} of ${findings.length}`,
    );
  });
});

const answerRejections = (r: { state: { events: readonly { type: string; nodeId?: string }[] } }) =>
  JSON.stringify(
    r.state.events.filter((e) => e.type === 'response-rejected' && e.nodeId === 'answer'),
  );

describe('investigate answers every sub-question', () => {
  it('one sub-answer per sub-question, each cited or said to be open; none skipped', () => {
    const skipping = (subAnswers: (s: Readonly<Record<string, unknown>>) => string[]) =>
      runWith(['workspace'], demo.approvals, {
        agents: {
          ...demo.agents,
          answer: (s, n) => {
            const good = demo.agents!.answer!(s, n);
            return n === 0
              ? { ...good, updates: { ...good.updates, subAnswers: subAnswers(s) } }
              : good;
          },
        },
      }).r;
    // Missing (the plan here has a single sub-question).
    expect(answerRejections(skipping(() => []))).toMatch(/one subAnswers entry per sub-question/);
    // Neither cited nor open.
    expect(
      answerRejections(
        skipping((s) => (s.subQuestions as string[]).map((_, i) => `S${i + 1}: it is fine`)),
      ),
    ).toMatch(/citing findings, or/);
    const ok = runWith(['workspace']).r;
    expect(ok.state.state.subAnswers).toEqual(
      (ok.state.state.subQuestions as string[]).map((_, i) =>
        expect.stringMatching(new RegExp(`^S${i + 1}: `)),
      ),
    );
  });
});

/** n checkable facts about files named <p><i>.ts. */
const facts = (p: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${p}${i}.ts:1 — f \`a b\``);

describe('investigate recalls for the sub-questions too', () => {
  it('a second recall uses the sub-questions; leads are merged within the usual caps', () => {
    const { r } = runWith(['workspace'], demo.approvals, {
      tools: {
        recall: () => ({ facts: facts('a', 8), lessons: ['l1', 'l2'] }),
        recallPlan: () => ({
          facts: [...facts('a', 2), ...facts('b', 8)],
          lessons: ['l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
        }),
      },
    });
    const s = r.state.state;
    const node = compileInvestigate({ goal: 'g', context: demo.context! }).nodes.find(
      (n) => n.id === 'recallPlan',
    );
    expect(node).toMatchObject({ tool: 'memory.recall', inputs: { query: 'subQuestions' } });
    expect(s.knownFacts).toHaveLength(12);
    expect((s.knownFacts as string[]).slice(0, 8)).toEqual(facts('a', 8));
    expect(s.pastLessons).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  });
});

describe('investigate reads the likeliest files first, and still every file', () => {
  it('the triage queue follows the engine ranking, which is an order and not a filter', () => {
    const { r } = runWith(['workspace']);
    const s = r.state.state;
    const batch = r.state.steps.find((x) => x.nodeId === 'triage')!.input!.batch as string[];
    expect(batch.slice(0, 3)).toEqual([
      'src/core/engine.ts',
      'src/core/schema.ts',
      'src/core/validate.ts',
    ]);
    expect((s.rankedFiles as string[]).toSorted()).toEqual((s.repoFiles as string[]).toSorted());
  });

  it('a ranking that is not the same files is ignored: the plain list is read', () => {
    const { r } = runWith(['workspace'], demo.approvals, {
      tools: {
        rankFiles: (s) => ({ ranked: ((s.repoFiles as string[]) ?? []).slice(1), matched: [] }),
      },
    });
    const batch = r.state.steps.find((x) => x.nodeId === 'triage')!.input!.batch as string[];
    expect(batch).toEqual(r.state.state.repoFiles);
  });
});

describe('investigate holds "read completely" to what the engine gave', () => {
  /** The demo, with the runtime's preload record on each deep read: what it could not give whole. */
  function withManifest(manifest: (batch: readonly string[], visit: number) => PreloadRecord[]) {
    const score = compileInvestigate({
      goal: 'g',
      context: demo.context!,
      generatedAt: 't',
    });
    let r = createEngine(score, { startedAt: 't' });
    const deepBatches: string[][] = [];
    for (let i = 0; i < 2000 && r.state.kind === 'running' && r.state.pause; i++) {
      const pause = r.state.pause;
      let res: Resolution = scriptedResolution(demo, pause, r.state, 't');
      if (pause.kind === 'agent' && pause.nodeId === 'deepRead' && res.kind === 'agent') {
        const batch = (
          pause.parts?.flatMap((p) => p.deepBatch as string[]) ??
          (pause.input.deepBatch as string[])
        ).filter((x) => !x.startsWith('http'));
        deepBatches.push(batch);
        res = {
          ...res,
          transcript: { ...res.transcript!, preloaded: manifest(batch, deepBatches.length - 1) },
        };
      }
      r = advance(score, r.state, res);
    }
    return { score, r, deepBatches };
  }

  it('a file cut short is read on in line-range chunks until done; one nothing of fit is retried alone', () => {
    // engine.ts is too long for one prompt (twice over); validate.ts was cut for the call's
    // size; nothing of schema.ts fit the first time. Chunks are given whole when asked for.
    const { score, r, deepBatches } = withManifest((batch, visit) =>
      batch.flatMap((item): PreloadRecord[] => {
        const { path, from, to } = itemOf(item);
        if (from !== undefined)
          return path.endsWith('engine.ts') && from === 4001
            ? [{ path, item, range: [from, to!], lines: 9000, omitted: [8001, 9000], cut: 'file' }]
            : [{ path, item, range: [from, to!], lines: 9000 }];
        if (path.endsWith('engine.ts'))
          return [{ path, lines: 9000, omitted: [4001, 9000], cut: 'file' }];
        if (path.endsWith('validate.ts') && visit === 0)
          return [{ path, lines: 900, omitted: [301, 900], cut: 'call' }];
        if (path.endsWith('schema.ts') && visit === 0)
          return [{ path, lines: 500, omitted: [1, 500], cut: 'call' }];
        return [{ path, lines: 100 }];
      }),
    );
    expect(r.state.kind).toBe('done');
    const s = r.state.state;
    const items = deepBatches.flat();
    // The rest of each cut file is read next, first in the queue, until the whole file is read.
    expect(deepBatches[1]!.slice(0, 2).toSorted()).toEqual([
      'src/core/engine.ts#chunk=4001-9000',
      'src/core/validate.ts#chunk=301-900',
    ]);
    expect(items).toContain('src/core/engine.ts#chunk=8001-9000');
    // Nothing of schema.ts fit: no chunk of it, reported and retried once, alone, at the end.
    expect(items.filter((x) => x.startsWith('src/core/schema.ts'))).toEqual([
      'src/core/schema.ts',
      'src/core/schema.ts',
    ]);
    expect(deepBatches).toContainEqual(['src/core/schema.ts']);
    expect(s.notRead).toEqual([]);
    // Output for every item read, chunks included.
    expect(s.readLog).toEqual(
      expect.arrayContaining([
        'src/core/engine.ts#chunk=8001-9000 — read in full',
        'src/core/validate.ts#chunk=301-900 — read in full',
      ]),
    );
    expect(replayPerformance(score, toPerformance(r.state)).divergence.reproduced).toBe(true);
  });

  it('an item missing from the record counts as not read (fails closed), and is reported', () => {
    const { r } = withManifest((batch) =>
      batch.filter((p) => !p.endsWith('engine.ts')).map((path) => ({ path, lines: 100 })),
    );
    const s = r.state.state;
    expect(s.notRead).toContain('src/core/engine.ts');
    const at = (s.notRead as string[]).indexOf('src/core/engine.ts');
    expect((s.notReadReasons as string[])[at]).toMatch(/not in the engine's record/);
    expect(String(s.answer)).toMatch(/Could not read in full: .*src\/core\/engine\.ts/);
  });

  it("each read note is matched to its item by what comes before ' — ', so paths may hold spaces", () => {
    // Both note checks: the deep read's (deepBatch) and the single-pass reader's (readFully).
    const checks = investigate.nodes.flatMap((n) =>
      ((n as unknown as { checks?: { expr: string }[] }).checks ?? []).flatMap((c) => {
        const m = /heads\(readNotes, .*\) == (\w+)$/.exec(c.expr);
        return m ? [{ expr: c.expr, field: m[1]! }] : [];
      }),
    );
    expect(checks.map((c) => c.field).toSorted()).toEqual(['deepBatch', 'readFully']);
    const items = ['Loop Experiences/plan.md', 'src/a.ts#chunk=401-800', 'src/b.ts'];
    for (const { expr, field } of checks) {
      const ok = (readNotes: string[]) => evaluateGuard(expr, { [field]: items, readNotes });
      expect(
        ok([
          'Loop Experiences/plan.md — the rollout plan',
          'src/a.ts#chunk=401-800 — nothing relevant',
          'src/b.ts – the retry loop',
        ]),
        field,
      ).toBe(true);
      // No dash: the first word, as before.
      expect(ok(['Loop Experiences/plan.md — x', 'src/a.ts#chunk=401-800 x', 'src/b.ts x'])).toBe(
        true,
      );
      expect(ok(['Loop Experiences/plan.md — x', 'src/b.ts — x'])).toBe(false);
      expect(
        ok(['src/b.ts — x', 'src/a.ts#chunk=401-800 — x', 'Loop Experiences/plan.md — x']),
      ).toBe(false);
      expect(ok(['Loop — x', 'src/a.ts#chunk=401-800 — x', 'src/b.ts — x'])).toBe(false);
    }
  });

  it('a reader that leaves out the note for an item is sent back', () => {
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        deepRead: (st, visit) => {
          const good = demo.agents!.deepRead!(st, visit);
          return {
            ...good,
            updates: { ...good.updates, readNotes: (good.updates.readNotes as string[]).slice(1) },
          };
        },
      },
    };
    const r = runScripted(compileInvestigate({ context: demo.context! }), script);
    expect(r.state.outcome).toBe('partial');
    expect(r.state.reason).toMatch(/exactly one readNotes entry per item of deepBatch/);
  });

  it('a file triage saw only part of goes to the deep read whatever triage said', () => {
    const score = compileInvestigate({
      goal: 'g',
      context: demo.context!,
      generatedAt: 't',
    });
    let r = createEngine(score, { startedAt: 't' });
    for (let i = 0; i < 2000 && r.state.kind === 'running' && r.state.pause; i++) {
      const pause = r.state.pause;
      let res: Resolution = scriptedResolution(demo, pause, r.state, 't');
      if (pause.kind === 'agent' && pause.nodeId === 'triage' && res.kind === 'agent')
        res = {
          ...res,
          transcript: {
            ...res.transcript!,
            preloaded: [{ path: 'src/cli.ts', lines: 5000, omitted: [3001, 5000], cut: 'file' }],
          },
        };
      r = advance(score, r.state, res);
    }
    // The demo's triage calls cli.ts irrelevant; it was not shown whole, so it is read in depth.
    expect(r.state.state.relevantFiles).toContain('src/cli.ts');
  });
});

describe('the support judge (off by default)', () => {
  /** The demo, answering with these citations and judging with this responder. */
  const judged = (
    cites: string,
    judge?: NonNullable<DemoScript['agents']>[string],
    context: Record<string, unknown> = {},
  ) => {
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        answer: (s, v) => {
          const good = demo.agents!.answer!(s, v);
          const subAnswers = ((s.subQuestions as string[]) ?? []).map(
            (_, i) => `S${i + 1}: so ${cites}`,
          );
          return {
            ...good,
            updates: {
              ...good.updates,
              answer: `It is checked ${cites}.`,
              subAnswers,
              // Resolutions too, so these are the only findings cited.
              objectionResolutions: ((s.realObjections as string[]) ?? []).map(
                (o) => `${o.split(':')[0]}: RESOLVED — so ${cites}`,
              ),
            },
          };
        },
        ...(judge ? { judgeSupport: judge } : {}),
      },
    };
    const r = runScripted(
      compileInvestigate({ goal: 'g', context: { ...demo.context!, ...context } }),
      script,
    );
    const ran = (id: string) => r.state.steps.filter((x) => x.nodeId === id).length;
    return { r, s: r.state.state, ran };
  };
  const verdict = {
    outcome: 'applied' as const,
    confidence: 1,
    shouldTerminate: false,
    reason: 'r',
  };
  /** Rules these ids UNSUPPORTED, the rest SUPPORTED. */
  const ruling =
    (bad: string[]): NonNullable<DemoScript['agents']>[string] =>
    (s) => ({
      updates: {
        supportRulings: ((s.judgeItems as string[]) ?? []).map((f) => {
          const id = f.split(' ')[0]!;
          return `${id}: ${bad.includes(id) ? 'UNSUPPORTED — the quote does not say it' : 'SUPPORTED — it does'}`;
        }),
      },
      verdict,
    });

  it('off: no judge runs, and everything cited is remembered', () => {
    const { s, ran } = judged('[F1] [F2]');
    expect(ran('judgeSupport')).toBe(0);
    expect(s.factsToKeep).toEqual(s.citedFindings);
  });

  it('(a) enforce: a finding the judge rules unsupported makes the answer partial, with the reason', () => {
    const { r, s, ran } = judged('[F1] [F2]', ruling(['F1']), { supportJudge: 'enforce' });
    expect(ran('judgeSupport')).toBe(1);
    expect(r.state.outcome).toBe('partial');
    expect(s.unsupportedIds).toEqual(['F1']);
    expect(s.doubts).toEqual([
      'The support judge found these cited findings unsupported by their own quotes: F1: UNSUPPORTED — the quote does not say it',
    ]);
    expect((s.factsToKeep as string[]).map((f) => f.split(' ')[0])).toEqual(['F2']);
  });

  it('shadow: the rulings are reported and the unsupported finding is not remembered; the outcome is unchanged', () => {
    const { r, s, ran } = judged('[F1] [F2]', ruling(['F1']), { supportJudge: 'shadow' });
    expect(r.state.outcome).toBe('success');
    expect(String(s.doubts)).toMatch(
      /\(shadow mode: reported, the outcome unchanged\): F1: UNSUPPORTED/,
    );
    expect(ran('rememberCited')).toBe(1);
    expect((s.factsToKeep as string[]).map((f) => f.split(' ')[0])).toEqual(['F2']);
  });

  it('(b) a ruling counts by the id it starts with: an id named inside a reason does not cover it', () => {
    let calls = 0;
    const { r, s } = judged(
      '[F1] [F2]',
      (st, v) => {
        calls += 1;
        return calls === 1
          ? { updates: { supportRulings: ['F1: SUPPORTED — F2 says the same'] }, verdict }
          : ruling([])(st, v);
      },
      { supportJudge: 'enforce' },
    );
    const rejected = r.state.events.flatMap((e) =>
      e.type === 'response-rejected' && e.nodeId === 'judgeSupport' ? e.errors : [],
    );
    expect(rejected.join()).toMatch(/one supportRulings entry per entry of judgeItems/);
    expect(s.unsupportedIds).toEqual([]);
    expect(r.state.outcome).toBe('success');
  });

  it('(c) with keepUnchallenged, an unsupported finding still ends partial, never stuck', () => {
    const { r } = judged('[F1]', ruling(['F1']), {
      supportJudge: 'enforce',
      keepUnchallenged: true,
    });
    expect(r.state.kind).toBe('done');
    expect(r.state.outcome).toBe('partial');
  });

  it('(d) web and other sources are uncheckable: said, never judged, never partial', () => {
    const { r, s, ran } = judged('[F7] [F8]', ruling(['F7', 'F8']), { supportJudge: 'enforce' });
    expect(ran('judgeSupport')).toBe(0);
    expect(r.state.outcome).toBe('success');
    expect(s.doubts).toEqual([
      '2 cited findings cite web pages or other sources: the support judge cannot check them',
    ]);
  });

  it('(e) judged in parallel parts, the rulings merge in order, one per finding', () => {
    const { s, r } = judged('[F1] [F2] [F3] [F5]', ruling(['F3']), {
      supportJudge: 'enforce',
      judgeBatch: 1,
    });
    const pause = r.state.events.flatMap((e) =>
      e.type === 'paused' && e.pause.kind === 'agent' && e.pause.nodeId === 'judgeSupport'
        ? [e.pause]
        : [],
    )[0]!;
    expect(pause.parts).toHaveLength(4);
    expect((s.supportRulings as string[]).map((x) => x.split(':')[0])).toEqual([
      'F1',
      'F2',
      'F3',
      'F5',
    ]);
    expect(s.unsupportedIds).toEqual(['F3']);
    // The judge sees each finding and its quote, not the question or the answer.
    expect(pause.isolated).toBe(true);
    expect(Object.keys(pause.input)).toEqual(['judgeItems']);
  });
});

describe('single-pass triage pilot (off by default)', () => {
  /** The demo with singlePass on; triage's transcript carries this preload record (null: none at all). */
  const pilot = (manifest?: ((batch: readonly string[]) => PreloadRecord[]) | null) => {
    const score = compileInvestigate({
      goal: 'g',
      context: { ...demo.context!, singlePass: true, batchSize: 10 },
      generatedAt: 't',
    });
    let r = createEngine(score, { startedAt: 't' });
    for (let i = 0; i < 2000 && r.state.kind === 'running' && r.state.pause; i++) {
      const pause = r.state.pause;
      let res: Resolution = scriptedResolution(demo, pause, r.state, 't');
      if (
        manifest !== undefined &&
        pause.kind === 'agent' &&
        pause.nodeId === 'triageDeep' &&
        res.kind === 'agent'
      )
        res = {
          ...res,
          transcript: {
            ...res.transcript!,
            preloaded: manifest ? manifest(pause.input.batch as string[]) : undefined,
          },
        };
      r = advance(score, r.state, res);
    }
    const deepRead = r.state.steps
      .filter((x) => x.nodeId === 'deepRead')
      .flatMap((x) => (x.input?.deepBatch as string[]) ?? []);
    return { r, s: r.state.state, deepRead, score };
  };
  const RELEVANT_FILES = ['src/core/engine.ts', 'src/core/schema.ts', 'src/core/validate.ts'];

  it('the single-pass reader writes a note per file it read in depth, as the deep read does', () => {
    const r = runScripted(compileInvestigate({ context: { ...demo.context!, singlePass: true } }), {
      ...demo,
      agents: {
        ...demo.agents,
        triageDeep: (s, visit) => {
          const good = demo.agents!.triageDeep!(s, visit);
          return {
            ...good,
            updates: {
              ...good.updates,
              readNotes: (good.updates.readNotes as string[]).slice(1),
            },
          };
        },
      },
    });
    expect(r.state.outcome).toBe('partial');
    expect(r.state.reason).toMatch(/one readNotes entry per file of readFully/);
    const ok = runScripted(
      compileInvestigate({ context: { ...demo.context!, singlePass: true } }),
      demo,
    );
    expect(ok.state.state.readLog).toEqual(
      expect.arrayContaining([expect.stringMatching(/ — read in depth at triage/)]),
    );
  });

  it('off: the usual triage plays, and every relevant file is read in depth', () => {
    const { r } = runWith(['workspace']);
    const ran = r.state.steps.map((x) => x.nodeId);
    expect(ran).toContain('triage');
    expect(ran).not.toContain('triageDeep');
  });

  it('no preload record: nothing is assumed read whole, every relevant file still gets a deep read', () => {
    const { r, deepRead } = pilot(null);
    expect(r.state.steps.map((x) => x.nodeId)).toContain('triageDeep');
    expect(deepRead).toEqual(expect.arrayContaining(RELEVANT_FILES));
  });

  it('files the record shows were given whole skip the deep read; one cut short does not, whatever triage says', () => {
    const { r, s, deepRead, score } = pilot((batch) =>
      batch.map(
        (path): PreloadRecord =>
          path.endsWith('validate.ts')
            ? { path, lines: 900, omitted: [301, 900], cut: 'call' }
            : { path, lines: 100 },
      ),
    );
    expect(r.state.outcome).toBe('success');
    // triage claimed all three read completely; the engine's record decides.
    expect(deepRead).toContain('src/core/validate.ts');
    expect(deepRead).not.toContain('src/core/engine.ts');
    expect(deepRead).not.toContain('src/core/schema.ts');
    expect(s.readFully).toEqual([]);
    expect(replayPerformance(score, toPerformance(r.state)).divergence.reproduced).toBe(true);
  });
});

describe('the step limit is a backstop, never the bound', () => {
  /** Every loop pushed: one sub-agent, every file relevant, gaps never close, the skeptic always objects. */
  const worst = (fileCount: number, context: Record<string, unknown> = {}) => {
    const v = { outcome: 'applied' as const, confidence: 0.2, shouldTerminate: false, reason: 'r' };
    const files = Array.from({ length: fileCount }, (_, i) => `src/m${i}.ts`);
    const script: DemoScript = {
      ...demo,
      tools: {
        ...demo.tools,
        inventory: () => ({ files, excluded: [] }),
        rankFiles: (s) => ({ ranked: s.repoFiles, matched: [] }),
      },
      approvals: {
        ...demo.approvals,
        clarify: () => ({ approved: true, updates: { hint: 'look harder' } }),
      },
      agents: {
        ...demo.agents,
        plan: (s) => ({
          updates: {
            subQuestions: ['q1', 'q2'],
            searchTerms: ['t'],
            useSources: s.sourceNames,
            skipSources: [],
            skipReasons: [],
            parts: [],
            agents: 1,
          },
          verdict: v,
        }),
        triage: (s) => ({
          updates: { triaged: s.batch, batchRelevant: s.batch, newFindings: [] },
          verdict: v,
        }),
        deepRead: withNotes((s) => {
          // One item of each batch unreadable at first: the retry pass plays too.
          const b = s.deepBatch as string[];
          const bad = (s.unreadRetries as number) === 0 ? b.slice(0, 1) : [];
          return {
            updates: {
              examined: b.filter((x) => !bad.includes(x)),
              unreadable: bad,
              unreadableReasons: bad.map(() => 'HTTP 429'),
              newFindings: [],
            },
            verdict: v,
          };
        }),
        designExperiments: (s) => {
          const all = Array.from({ length: s.maxExperiments as number }, (_, i) => `exp ${i}`);
          return {
            updates: { experiments: all, timedExperiments: all.slice(0, all.length / 2) },
            verdict: v,
          };
        },
        assess: (s) => ({
          updates: { ...assessFor(s, [(s.subQuestions as string[])[0]!]), confidence: 0.2 },
          verdict: v,
        }),
        challenge: (_s, visit) => ({
          updates: { objections: [`S1: F1 still open (round ${visit})`] },
          verdict: v,
        }),
      },
    };
    const score = compileInvestigate({
      goal: 'g',
      context: { ...demo.context!, question: 'q', complexity: 4, ...context },
    });
    return { r: runScripted(score, script), max: score.maxSteps };
  };

  it('the worst case ends far below maxSteps, with the counters at default and raised', () => {
    for (const raised of [
      {},
      { maxChaseRounds: 20, maxDebateRounds: 5, maxGapRounds: 5, maxExperiments: 20 },
    ]) {
      const { r, max } = worst(300, raised);
      expect(r.state.kind).toBe('done');
      expect(r.state.cursor).toBe('doubts');
      expect(r.state.steps.length).toBeLessThanOrEqual(700);
      expect(r.state.steps.length).toBeLessThanOrEqual(max / 3);
    }
  }, 30_000);

  it('exhaustive on a huge repository stops at the citation check cap, not at maxSteps', () => {
    const { r, max } = worst(700, { exhaustive: true, batchSize: 1 });
    expect(r.state.outcome).toBe('partial');
    expect(r.state.cursor).toBe('checkTriage');
    expect(r.state.visits.checkTriage).toBe(200);
    expect(r.state.steps.length).toBeLessThan(max);
  }, 30_000);
});

describe('lean (on by default): the settings measured to cut time and tokens, behind one switch', () => {
  const play = (context: Record<string, unknown> = {}, rated = 2, complexity?: 1 | 2 | 3 | 4) => {
    const script: DemoScript = {
      ...demo,
      agents: {
        ...demo.agents,
        hypothesize: (s, visit) => {
          const r = demo.agents!.hypothesize!(s, visit);
          return { ...r, updates: { ...r.updates, ratedComplexity: rated } };
        },
      },
    };
    const score = compileScore(investigate, {
      goal: 'g',
      context: { ...demo.context!, ...context },
      ...(complexity ? { complexity } : {}),
    });
    return runScripted(score, script);
  };

  it('on: one debate round, single-pass triage, gap-aimed research, sub-answers kept, a sub-agent per gap', () => {
    const r = play();
    expect(r.state.outcome).toBe('success');
    expect(r.state.state).toMatchObject({
      lean: true,
      maxDebateRounds: 1,
      singlePass: true,
      gapAimed: true,
      keepUnchallenged: true,
      gapsPerChase: 1,
    });
    expect(r.state.steps.some((x) => x.nodeId === 'triageDeep')).toBe(true);
  });

  it('off: each setting as set on its own', () => {
    const r = play({ lean: false });
    expect(r.state.outcome).toBe('success');
    expect(r.state.state).toMatchObject({
      maxDebateRounds: 2,
      singlePass: false,
      gapAimed: false,
      keepUnchallenged: false,
      gapsPerChase: 99,
    });
    expect(r.state.steps.some((x) => x.nodeId === 'triageDeep')).toBe(false);
    // Lean never raises a cap set lower.
    expect(play({ maxDebateRounds: 0 }).state.state.maxDebateRounds).toBe(0);
  });

  it('caps an AI-rated 4 at 3; a complexity chosen for the run stays', () => {
    expect(play({}, 4).state.state.complexity).toBe(3);
    expect(play({ lean: false }, 4).state.state.complexity).toBe(4);
    expect(play({}, 4, 4).state.state.complexity).toBe(4);
    // Given but only rated (the maestro's classifier): capped like the investigation's own rating.
    expect(play({ complexityRated: true }, 4, 4).state.state.complexity).toBe(3);
    expect(play({}, 2).state.state.complexity).toBe(2);
  });
});
