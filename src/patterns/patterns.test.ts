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

  it('investigate loops through the human hint before answering', () => {
    const p = findPattern('investigate')!;
    const score = compileScore(p, { goal: 'g', context: p.demo!.context! });
    const r = runScripted(score, p.demo);
    expect(r.state.steps.map((s) => s.nodeId)).toEqual([
      'start',
      'gather',
      'confident',
      'clarify',
      'gather',
      'confident',
      'answer',
      'done',
    ]);
  });

  it('fix retries apply/verify once then succeeds', () => {
    const p = findPattern('fix')!;
    const r = runScripted(compileScore(p, { goal: 'g', context: p.demo!.context! }), p.demo);
    expect(r.state.state).toMatchObject({ attempts: 2, testsPassed: true });
    expect(r.state.cursor).toBe('fixed');
  });

  it('runs a pattern without demo scripts using placeholders', () => {
    const p = findPattern('review')!;
    const r = runScripted(compileScore(p, { goal: 'g', context: { target: 'x' } }), undefined);
    expect(r.state.kind).toBe('done');
    expect(r.state.cursor).toBe('clean');
  });

  it('routes prompts by verb triggers', () => {
    expect(routePrompt('Please fix this broken test')?.name).toBe('fix');
    expect(routePrompt('review my PR')?.name).toBe('review');
    expect(routePrompt('hello')).toBeUndefined();
  });
});
