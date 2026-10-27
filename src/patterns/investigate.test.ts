import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { runScripted } from '../core/scripted.js';
import type { DemoScript } from '../core/types.js';
import { investigate } from './index.js';

const demo = investigate.demo!;

/** Run investigate with the plan using exactly `use` (everything else skipped). */
function runWith(use: string[], approvals: DemoScript['approvals'] = demo.approvals) {
  const script: DemoScript = {
    ...demo,
    ...(approvals ? { approvals } : {}),
    agents: {
      ...demo.agents,
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
  const score = compileScore(investigate, { goal: 'g', context: { question: 'q' } });
  const r = runScripted(score, script);
  return { r, ran: r.state.steps.map((s) => s.nodeId) };
}

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

  it('performance question: designs experiments and runs them after approval', () => {
    const { r, ran } = runWith(['workspace', 'web', 'experiment']);
    expect(ran).toEqual(
      expect.arrayContaining(['designExperiments', 'allowExperiments', 'experiment']),
    );
    expect(r.state.state.ran).toHaveLength(1);
    expect((r.state.state.findings as string[]).some((f) => f.startsWith('experiment |'))).toBe(
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
