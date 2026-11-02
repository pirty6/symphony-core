import { describe, expect, it } from 'vitest';
import { featureInputs, FEATURES } from './catalog.js';
import { compileScore } from './compile.js';
import { runScripted } from './scripted.js';
import { composedScore, investigate, maestro, PATTERNS } from '../patterns/index.js';

describe('feature switches', () => {
  it.each(FEATURES.map((f) => [f.field, f] as const))(
    '%s is a field of a library pattern, of the right type, defaulting to one of its choices',
    (_field, f) => {
      const fields = PATTERNS.flatMap((p) => p.state.filter((s) => s.name === f.field));
      expect(fields.length).toBeGreaterThan(0);
      for (const s of fields) {
        if (!f.choices) {
          expect(s.type).toBe('boolean');
          continue;
        }
        expect(['string', 'number']).toContain(s.type);
        const values = f.choices.map((c) => c.value);
        expect(values).toContain(String(s.initial ?? (s.type === 'number' ? 0 : '')));
        if (s.type === 'number')
          for (const v of values) expect(Number.isFinite(Number(v))).toBe(true);
      }
    },
  );
});

describe('featureInputs', () => {
  it("types the chosen switches for the pattern's own fields and drops the rest", () => {
    expect(
      featureInputs(investigate, {
        supportJudge: 'shadow',
        singlePass: 'true',
        readerHypotheses: 'false',
        pragmatistFrom: '2',
        gapsPerChase: '1',
        notAFeature: 'x',
      }),
    ).toEqual({
      supportJudge: 'shadow',
      singlePass: true,
      readerHypotheses: false,
      pragmatistFrom: 2,
      gapsPerChase: 1,
    });
    // A value the switch does not offer, and a pattern without the field: nothing.
    expect(featureInputs(investigate, { supportJudge: 'always', singlePass: 'yes' })).toEqual({});
    expect(featureInputs({ state: [] }, { supportJudge: 'shadow' })).toEqual({});
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
    const composed = composedScore(score, s, { features: { supportJudge: 'shadow' } });
    expect(composed?.pattern.name).toBe('investigate');
    expect(composed!.score.context.supportJudge).toBe('shadow');
  });
});
