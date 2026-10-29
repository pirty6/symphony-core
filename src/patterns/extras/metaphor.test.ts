import { describe, expect, it } from 'vitest';
import { compileScore } from '../../core/compile.js';
import { parseDraft } from '../../core/draft.js';
import { toPerformance } from '../../core/engine.js';
import { replayPerformance } from '../../core/replay.js';
import { runScripted } from '../../core/scripted.js';
import type { DemoScript } from '../../core/types.js';
import { libraryPatterns, PATTERNS, routePrompt } from '../index.js';
import { enabledExtras, EXTRAS, metaphor, stormInBetween } from './index.js';
import { METAPHOR_RULES } from './metaphor.js';

const demo = metaphor.demo!;
const names = (env: Record<string, string>) => libraryPatterns(env).map((p) => p.name);
const v = { outcome: 'applied' as const, confidence: 0.9, shouldTerminate: false, reason: 'r' };
const draftOf = (over: Record<string, unknown>) => () => ({
  updates: {
    draft: { ...(demo.agents!.draft!({}, 0).updates!.draft as Record<string, unknown>), ...over },
  },
  verdict: v,
});

function play(over: Partial<DemoScript> = {}) {
  const script: DemoScript = {
    ...demo,
    ...over,
    agents: { ...demo.agents, ...over.agents },
    tools: { ...demo.tools, ...over.tools },
    approvals: { ...demo.approvals, ...over.approvals },
  };
  const score = compileScore(metaphor, { context: demo.context!, generatedAt: 't' });
  const r = runScripted(score, script, { at: 't' });
  expect(replayPerformance(score, toPerformance(r.state)).divergence.reproduced).toBe(true);
  const ran = (id: string) => r.state.steps.filter((s) => s.nodeId === id).length;
  return { r, ran, state: r.state.state, end: r.state.cursor };
}

describe('metaphor', () => {
  it('reads the metaphor, maps it by the rules, drafts, validates, and saves the pattern', () => {
    const { r, ran, state, end } = play();
    expect(r.state.outcome).toBe('success');
    expect(end).toBe('saved');
    expect(['read', 'map', 'draft', 'validate', 'approve', 'save'].map(ran)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    expect(state.patternName).toBe('storm-listening');
    expect(state.savedFile).toBe('src/patterns/drafts/storm-listening.ts');
  });

  it("the demo's drafted pattern is a real, valid, runnable pattern", () => {
    const parsed = parseDraft(demo.agents!.draft!({}, 0).updates!.draft);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    if (parsed.ok)
      expect(() => compileScore(parsed.value, { context: { subject: 'x' } })).not.toThrow();
  });

  it('an invalid draft goes back with the errors, and gives up after maxRounds', () => {
    let n = 0;
    const fixedLater = play({
      tools: {
        validate: (s) =>
          ++n === 1
            ? { errors: ['edge e9: unknown node'], valid: false, pattern: {} }
            : demo.tools!.validate!(s),
      },
    });
    expect(fixedLater.ran('draft')).toBe(2);
    expect(fixedLater.end).toBe('saved');
    const never = play({
      tools: { validate: () => ({ errors: ['bad'], valid: false, pattern: {} }) },
    });
    expect(never.ran('draft')).toBe(3);
    expect(never.end).toBe('invalid');
    expect(never.ran('save')).toBe(0);
  });

  it('never saves over a built-in pattern: the name goes back to the draft', () => {
    let n = 0;
    const { ran, state, end } = play({
      agents: { draft: () => (++n === 1 ? draftOf({ name: 'fix' })() : draftOf({})()) },
    });
    expect(ran('draft')).toBe(2);
    expect(state.patternName).toBe('storm-listening');
    expect(end).toBe('saved');
  });

  it('feedback at the approval revises the draft (bounded); rejecting saves nothing', () => {
    const revised = play({
      approvals: {
        approve: (_s, visit) => ({
          approved: true,
          updates: { feedback: visit === 0 ? 'name the edge "lightning"' : '' },
        }),
      },
    });
    expect(revised.ran('draft')).toBe(2);
    expect(revised.end).toBe('saved');
    const tooMany = play({
      approvals: { approve: () => ({ approved: true, updates: { feedback: 'again' } }) },
    });
    expect(tooMany.end).toBe('notSaved');
    expect(tooMany.ran('save')).toBe(0);
    const rejected = play({ approvals: { approve: () => ({ approved: false }) } });
    expect(rejected.end).toBe('notSaved');
    expect(rejected.ran('save')).toBe(0);
  });

  it('maps by explicit rules, and is routed from metaphor requests', () => {
    const map = metaphor.nodes.find((n) => n.id === 'map');
    for (const rule of METAPHOR_RULES) expect(JSON.stringify(map)).toContain(rule.split(':')[0]);
    const ask = 'Create a symphony pattern that from a metaphor can create symphony patterns';
    expect(routePrompt(ask, [...PATTERNS, metaphor])?.name).toBe('metaphor');
  });

  it('is optional: only in the library when SYMPHONY_EXTRAS turns it on', () => {
    expect(PATTERNS.map((p) => p.name)).not.toContain('metaphor');
    expect(names({})).not.toContain('metaphor');
    expect(names({})).not.toContain('storm-in-between');
    expect(names({ SYMPHONY_EXTRAS: 'metaphor' })).toContain('metaphor');
    expect(names({ SYMPHONY_EXTRAS: 'metaphor' })).not.toContain('storm-in-between');
    expect(enabledExtras({ SYMPHONY_EXTRAS: ' ALL ' })).toEqual([...EXTRAS]);
    // A draft never shadows a pattern that is on.
    const draft = { ...stormInBetween, description: 'mine' };
    expect(
      libraryPatterns({ SYMPHONY_EXTRAS: 'all' }, [draft]).filter(
        (p) => p.name === 'storm-in-between',
      ),
    ).toEqual([stormInBetween]);
    expect(libraryPatterns({}, [draft]).find((p) => p.name === 'storm-in-between')).toBe(draft);
  });
});
