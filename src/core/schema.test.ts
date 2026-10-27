import { describe, expect, it } from 'vitest';
import {
  checkValue,
  isValidFieldName,
  resultJsonSchema,
  validateNodeResult,
  validateUpdates,
  validateVerdict,
  zeroValue,
} from './schema.js';
import type { StateField } from './types.js';

const verdict = { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'ok' };
const writes: StateField[] = [
  { name: 'word', type: 'string' },
  { name: 'tags', type: 'string[]' },
];

describe('checkValue', () => {
  it.each([
    ['string', 'x', true],
    ['string', 1, false],
    ['number', 1.5, true],
    ['number', Number.NaN, false],
    ['boolean', false, true],
    ['string[]', ['a'], true],
    ['string[]', ['a', 1], false],
    ['number[]', [1, 2], true],
    ['object', {}, true],
    ['object', [], false],
    ['object', null, false],
  ] as const)('%s accepts %j = %s', (type, value, ok) => {
    expect(checkValue(type, value) === undefined).toBe(ok);
  });

  it('zero values pass their own type', () => {
    for (const t of ['string', 'number', 'boolean', 'string[]', 'number[]', 'object'] as const) {
      expect(checkValue(t, zeroValue(t))).toBeUndefined();
    }
  });
});

describe('validateVerdict', () => {
  it('accepts a valid verdict', () => expect(validateVerdict(verdict)).toEqual([]));
  it('rejects NaN confidence, bad outcome, missing fields', () => {
    expect(validateVerdict({ ...verdict, confidence: Number.NaN })).toHaveLength(1);
    expect(validateVerdict({ ...verdict, outcome: 'done' })).toHaveLength(1);
    expect(validateVerdict({})).toHaveLength(4);
    expect(validateVerdict('nope')).toHaveLength(1);
  });
});

describe('validateUpdates', () => {
  it('rejects keys outside writes and wrong types', () => {
    const errors = validateUpdates({ word: 3, secret: 'x' }, writes, false);
    expect(errors.join('\n')).toMatch(/updates.word: expected string/);
    expect(errors.join('\n')).toMatch(/updates.secret is not writable/);
  });

  it('requires all writes when asked', () => {
    expect(validateUpdates({ word: 'a' }, writes, true)).toEqual(['updates.tags is required']);
  });
});

describe('validateNodeResult', () => {
  it('accepts a complete applied result', () => {
    const r = validateNodeResult({ updates: { word: 'a', tags: [] }, verdict }, writes);
    expect(r.ok).toBe(true);
  });

  it('allows partial updates when not applied', () => {
    const r = validateNodeResult({ verdict: { ...verdict, outcome: 'failed' } }, writes);
    expect(r).toEqual({
      ok: true,
      value: { updates: {}, verdict: { ...verdict, outcome: 'failed' } },
    });
  });

  it('rejects non-objects and missing writes when applied', () => {
    expect(validateNodeResult('text', writes).ok).toBe(false);
    expect(validateNodeResult({ updates: { word: 'a' }, verdict }, writes).ok).toBe(false);
  });
});

describe('isValidFieldName', () => {
  it('blocks reserved and invalid names', () => {
    expect(isValidFieldName('word')).toBe(true);
    expect(isValidFieldName('verdict')).toBe(false);
    expect(isValidFieldName('state')).toBe(false);
    expect(isValidFieldName('1x')).toBe(false);
    expect(isValidFieldName('a-b')).toBe(false);
  });
});

describe('resultJsonSchema', () => {
  it('describes updates + verdict', () => {
    const s = resultJsonSchema(writes) as { properties: { updates: { required: string[] } } };
    expect(s.properties.updates.required).toEqual(['word', 'tags']);
  });
});
