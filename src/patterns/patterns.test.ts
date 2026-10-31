import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { toPerformance } from '../core/engine.js';
import { hashOf } from '../core/hash.js';
import { runScripted } from '../core/scripted.js';
import { validatePattern } from '../core/validate.js';
import { findPattern, PATTERNS, routePrompt } from './index.js';

describe('pattern library', () => {
  it.each(PATTERNS.map((p) => [p.name, p] as const))('%s is valid', (_name, p) => {
    const report = validatePattern(p);
    expect(report.errors).toEqual([]);
  });

  it.each(PATTERNS.map((p) => [p.name, p] as const))(
    '%s demo runs to completion deterministically',
    (_n, p) => {
      const score = compileScore(p, {
        goal: p.demo?.goal ?? 'demo',
        context: p.demo?.context ?? {},
        generatedAt: 't',
      });
      const a = runScripted(score, p.demo, { at: 't' });
      const b = runScripted(score, p.demo, { at: 't' });
      expect(a.state.kind).toBe('done');
      expect(['success', 'partial']).toContain(a.state.outcome);
      expect(hashOf(toPerformance(a.state))).toBe(hashOf(toPerformance(b.state)));
    },
  );

  it('investigate covers every file, every chosen source and closes gaps', () => {
    const p = findPattern('investigate')!;
    // Small batches, one sub-agent: a round triages three files, so the loop takes several rounds.
    const score = compileScore(p, {
      goal: 'g',
      context: { ...p.demo!.context!, batchSize: 1, agents: 1 },
    });
    const r = runScripted(score, p.demo);
    expect(r.state.outcome).toBe('success');
    const steps = r.state.steps;
    const triaged = steps
      .filter((s) => s.nodeId === 'triage')
      .flatMap((s) => s.updates?.triaged as string[]);
    expect(triaged.toSorted()).toEqual((r.state.state.repoFiles as string[]).toSorted());
    expect(steps.filter((s) => s.nodeId === 'triage')).toHaveLength(2);
    // By default a round plays several batches at once (fanOut) and covers the same files.
    const wide = runScripted(
      compileScore(p, { goal: 'g', context: { ...p.demo!.context!, batchSize: 2 } }),
      p.demo,
    );
    const wideTriage = wide.state.steps.filter((s) => s.nodeId === 'triage');
    expect(wideTriage).toHaveLength(1);
    expect(((wideTriage[0]!.updates?.triaged as string[] | undefined) ?? []).toSorted()).toEqual(
      triaged.toSorted(),
    );
    const examined = steps
      .filter((s) => s.nodeId === 'deepRead')
      .flatMap((s) => s.updates?.examined as string[]);
    expect(examined.toSorted()).toEqual([
      'https://en.wikipedia.org/wiki/Finite-state_machine',
      'src/core/engine.ts',
      'src/core/schema.ts',
      'src/core/validate.ts',
    ]);
    expect(r.state.state.consulted).toEqual(['git-history']);
    expect(r.state.state.skipSources).toEqual(['experiment', 'prior-runs']);
    // One gap round, then one round for the skeptic's objection.
    expect(steps.filter((s) => s.nodeId === 'chase')).toHaveLength(2);
    expect(steps.filter((s) => s.nodeId === 'assess')).toHaveLength(3);
    expect(r.state.state.openQuestions).toEqual([]);
    // The debate: hypotheses up front, the skeptic twice, a ruling on every hypothesis.
    expect(steps.filter((s) => s.nodeId === 'hypothesize')).toHaveLength(1);
    expect(steps.filter((s) => s.nodeId === 'challenge')).toHaveLength(2);
    expect(steps.some((s) => s.nodeId === 'second')).toBe(false);
    const st = r.state.state;
    expect((st.rulings as string[]).length).toBe((st.hypotheses as string[]).length);
    expect(st.debateRounds).toBe(1);
  });

  it('investigate rejects a plan that ignores a source and a triage that skips a file', () => {
    const p = findPattern('investigate')!;
    const score = compileScore(p, { goal: 'g', context: p.demo!.context! });
    const calls = { plan: 0, triage: 0 };
    const lazy = {
      ...p.demo!,
      agents: {
        ...p.demo!.agents,
        plan: (s: Readonly<Record<string, unknown>>, visit: number) => {
          const good = p.demo!.agents!.plan!(s, visit);
          return calls.plan++ === 0
            ? {
                ...good,
                updates: { ...good.updates, useSources: [], skipSources: [], skipReasons: [] },
              }
            : good;
        },
        triage: (s: Readonly<Record<string, unknown>>, visit: number) => {
          const good = p.demo!.agents!.triage!(s, visit);
          return calls.triage++ === 0
            ? { ...good, updates: { ...good.updates, triaged: [] } }
            : good;
        },
      },
    };
    const r = runScripted(score, lazy);
    expect(r.state.outcome).toBe('success');
    const rejected = r.state.events.filter((e) => e.type === 'response-rejected');
    expect(rejected.map((e) => e.type === 'response-rejected' && e.nodeId)).toEqual([
      'plan',
      'triage',
    ]);
    expect(rejected[0]!.type === 'response-rejected' && rejected[0]!.errors.join()).toMatch(
      /Decide on EVERY source/,
    );
    expect(rejected[1]!.type === 'response-rejected' && rejected[1]!.errors.join()).toMatch(
      /You skipped files/,
    );
  });

  it('fix retries apply/verify once then succeeds', () => {
    const p = findPattern('fix')!;
    const r = runScripted(compileScore(p, { goal: 'g', context: p.demo!.context! }), p.demo);
    expect(r.state.state).toMatchObject({ attempts: 2, testsPassed: true });
    expect(r.state.cursor).toBe('fixed');
  });

  it('raising a counter never hits a hard-coded cap (analyze with 14 analyses)', () => {
    const p = findPattern('analyze')!;
    const r = runScripted(
      compileScore(p, {
        goal: 'g',
        context: { ...p.demo!.context!, maxAnalyses: 14 },
        improvisation: 0,
      }),
      p.demo,
    );
    expect(r.state.outcome).toBe('success');
    expect(r.state.state.analyses).toHaveLength(14);
  });

  it('runs a pattern without demo scripts using placeholders', () => {
    const p = findPattern('review')!;
    const r = runScripted(compileScore(p, { goal: 'g', context: { target: 'x' } }), undefined);
    // Placeholder answers review nothing: the run ends, and never as a clean review.
    expect(['done', 'failed']).toContain(r.state.kind);
    expect(r.state.outcome).not.toBe('success');
  });

  it('review ends honestly: a failed analysis is not "looks good"', () => {
    const p = findPattern('review')!;
    const score = compileScore(p, { goal: 'g', context: p.demo!.context! });
    const ok = runScripted(score, p.demo);
    expect(ok.state).toMatchObject({ cursor: 'issues', outcome: 'success' });
    expect(ok.state.state.findings).toEqual([
      'F1 src/core/engine.ts:120 — retry counter never resets `attempts += 1`',
    ]);
    const blind = runScripted(score, {
      ...p.demo!,
      agents: {
        ...p.demo!.agents,
        analyze: (s) => ({
          updates: { newFindings: [], reviewed: (s.files as string[]) ?? [] },
          verdict: {
            outcome: 'failed',
            confidence: 0.2,
            shouldTerminate: false,
            reason: 'gh failed',
          },
        }),
      },
    });
    expect(blind.state).toMatchObject({ cursor: 'notReviewed', outcome: 'failed' });
    const sound = runScripted(score, {
      ...p.demo!,
      agents: {
        ...p.demo!.agents,
        analyze: (s) => ({
          updates: { newFindings: [], reviewed: (s.files as string[]) ?? [] },
          verdict: { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'ok' },
        }),
      },
    });
    expect(sound.state).toMatchObject({ cursor: 'clean', outcome: 'success' });
    expect(sound.state.state.report).toBe('No real issues found. Reviewed: src/core/engine.ts');
  });

  it('maestro prompts avoid wording that provider content filters blocked', () => {
    const blocked = /how (i|we) got here|unsure, cut|what i cut|what i am not sure/i;
    const texts = findPattern('maestro')!.nodes.flatMap((n) =>
      n.kind === 'agent' ? [n.directive] : [],
    );
    const fields = findPattern('maestro')!.state.map((f) => f.description ?? '');
    expect([...texts, ...fields].filter((t) => blocked.test(t))).toEqual([]);
  });

  it('routes prompts by verb triggers', () => {
    expect(routePrompt('Please fix this broken test')?.name).toBe('fix');
    expect(routePrompt('review my PR')?.name).toBe('review');
    expect(routePrompt('Implement a --json flag for list')?.name).toBe('implement');
    expect(routePrompt('add support for YAML config files')?.name).toBe('implement');
    // A bug fix that adds a test is still a fix; "address" is not "add".
    expect(routePrompt('fix the crash and add a test')?.name).toBe('fix');
    expect(routePrompt('address the review comments')?.name).toBe('review');
    // Whole words with verb endings: no more "add" inside "address", "play" inside "display".
    expect(routePrompt('fixing the crashes in login')?.name).toBe('fix');
    expect(routePrompt('adding support for YAML')?.name).toBe('implement');
    expect(routePrompt('display the address book')).toBeUndefined();
    expect(routePrompt('update the database schema docs')).toBeUndefined();
    expect(routePrompt('hello')).toBeUndefined();
    // The opening verb names what is asked, even when other patterns are mentioned after it.
    expect(
      routePrompt(
        'investigate how to improve the investigate, fix, refactor, implement, backlog, review and analyze algorithms',
      )?.name,
    ).toBe('investigate');
    expect(routePrompt('review how we fix and refactor code')?.name).toBe('review');
  });
});
