import { describe, expect, it } from 'vitest';
import { type Feature, featureInputs, FEATURES } from './catalog.js';
import { compileScore } from './compile.js';
import { runScripted } from './scripted.js';
import type { StateField } from './types.js';
import { composedScore, investigate, maestro, PATTERNS } from '../patterns/index.js';

/** Why a library field does not fit its switch: the wrong type, or a default or choice that cannot be. */
function fieldMisfits(f: Feature, s: StateField): string[] {
  if (!f.choices) return s.type === 'boolean' ? [] : [`${f.field} is ${s.type}, not boolean`];
  if (s.type !== 'string' && s.type !== 'number') return [`${f.field} is ${s.type}`];
  const values = f.choices.map((c) => c.value);
  const initial = String(s.initial ?? (s.type === 'number' ? 0 : ''));
  const badDefault = values.includes(initial) ? [] : [`${f.field} defaults to ${initial}`];
  const badNumbers = s.type === 'number' ? values.filter((v) => !Number.isFinite(Number(v))) : [];
  return [...badDefault, ...badNumbers.map((v) => `${f.field} offers ${v}, not a number`)];
}

/** Every way a switch fails to be a field of a library pattern, of the right type and default. */
function switchMisfits(f: Feature): string[] {
  const fields = PATTERNS.flatMap((p) => p.state.filter((s) => s.name === f.field));
  return fields.length
    ? fields.flatMap((s) => fieldMisfits(f, s))
    : [`${f.field} is in no pattern`];
}

describe('feature switches', () => {
  it('each is a field of a library pattern, of the right type, defaulting to one of its choices', () => {
    expect(FEATURES.length).toBeGreaterThan(0);
    expect(FEATURES.flatMap(switchMisfits)).toEqual([]);
  });
});

describe('featureInputs', () => {
  it("types the chosen switches for the pattern's own fields and drops the rest", () => {
    expect(
      featureInputs(investigate, {
        singlePass: 'true',
        readerHypotheses: 'false',
        pragmatistFrom: '2',
        gapsPerChase: '1',
        notAFeature: 'x',
      }),
    ).toEqual({
      singlePass: true,
      readerHypotheses: false,
      pragmatistFrom: 2,
      gapsPerChase: 1,
    });
    // A value the switch does not offer, and a pattern without the field: nothing.
    expect(featureInputs(investigate, { pragmatistFrom: '7', singlePass: 'yes' })).toEqual({});
    expect(featureInputs({ state: [] }, { pragmatistFrom: '2' })).toEqual({});
  });

  it('the score the maestro composes plays with the switches you chose', () => {
    const score = compileScore(maestro, {
      goal: 'compose',
      context: { request: 'Why is the build slow?' },
    });
    const s = runScripted(score, {
      ...maestro.demo!,
      agents: {
        ...maestro.demo!.agents,
        classify: (st, v) => {
          const good = maestro.demo!.agents!.classify!(st, v);
          return { ...good, updates: { ...good.updates, chosen: 'investigate' } };
        },
      },
    }).state.state;
    const composed = composedScore(score, s, { features: { pragmatistFrom: '2' } });
    expect(composed?.pattern.name).toBe('investigate');
    expect(composed!.score.context.pragmatistFrom).toBe(2);
  });
});
