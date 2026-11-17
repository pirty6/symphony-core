import { describe, expect, it } from 'vitest';
import {
  checkAgentResult,
  checkValue,
  formatFieldInput,
  parseFieldInput,
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
  it('a string accepts text', () => {
    expect(checkValue('string', 'x')).toBeUndefined();
  });

  it('a string refuses a number', () => {
    expect(checkValue('string', 1)).toBeDefined();
  });

  it('a number accepts a fraction', () => {
    expect(checkValue('number', 1.5)).toBeUndefined();
  });

  it('a number refuses NaN', () => {
    expect(checkValue('number', Number.NaN)).toBeDefined();
  });

  it('a boolean accepts false', () => {
    expect(checkValue('boolean', false)).toBeUndefined();
  });

  it('a string list accepts a list of text', () => {
    expect(checkValue('string[]', ['a'])).toBeUndefined();
  });

  it('a string list refuses a list with a number in it', () => {
    expect(checkValue('string[]', ['a', 1])).toBeDefined();
  });

  it('a number list accepts a list of numbers', () => {
    expect(checkValue('number[]', [1, 2])).toBeUndefined();
  });

  it('an object accepts {}', () => {
    expect(checkValue('object', {})).toBeUndefined();
  });

  it('an object refuses a list', () => {
    expect(checkValue('object', [])).toBeDefined();
  });

  it('an object refuses null', () => {
    expect(checkValue('object', null)).toBeDefined();
  });

  it('zero values pass their own type', () => {
    const types = ['string', 'number', 'boolean', 'string[]', 'number[]', 'object'] as const;
    expect(types.map((t) => checkValue(t, zeroValue(t)))).toEqual(types.map(() => undefined));
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

describe('checkAgentResult (regressions from a live deepRead failure)', () => {
  const deepWrites: StateField[] = [
    { name: 'examined', type: 'string[]' },
    { name: 'newFindings', type: 'string[]' },
  ];
  const updates = { examined: ['src/cli.ts'], newFindings: ['src/cli.ts:1 — finding'] };

  it('rejects a garbled tool call whose fields arrived as text', () => {
    // Recorded verbatim (shortened) from the failed run: the model leaked XML into the JSON.
    const garbled = {
      updates: '\n<parameter name="examined">["src/cli.ts"]',
      newFindings: ['src/cli.ts:1 — finding'],
      verdict: '\n<parameter name="outcome">applied',
      confidence: 0.9,
      shouldTerminate: false,
      reason: 'done',
    };
    expect(checkAgentResult(garbled, deepWrites)).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^updates arrived as text/)],
    });
  });

  it('names a missing verdict and shows the expected shape', () => {
    const r = checkAgentResult({ updates }, deepWrites);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(
      /^verdict is missing: .*"outcome".*"confidence".*"shouldTerminate".*"reason"/,
    );
  });

  it('says what a non-object verdict was', () => {
    const r = checkAgentResult({ updates, verdict: 'applied' }, deepWrites);
    expect(!r.ok && r.errors[0]).toMatch(/^verdict must be an object .*got "applied"/);
    expect(checkAgentResult({ updates, verdict: [] }, deepWrites).ok).toBe(false);
  });

  it('rejects keys the node may not write', () => {
    const r = checkAgentResult(
      { updates: { ...updates, examined_note: 'x' }, verdict },
      deepWrites,
    );
    expect(!r.ok && r.errors[0]).toMatch(/examined_note is not writable/);
  });

  it('accepts the corrected answer, and checks solo routes', () => {
    expect(checkAgentResult({ updates, verdict }, deepWrites)).toEqual({
      ok: true,
      value: { updates, verdict },
    });
    const choices = [{ edgeId: 'a' }, { edgeId: 'b' }];
    expect(checkAgentResult({ updates, verdict }, deepWrites, choices).ok).toBe(false);
    expect(checkAgentResult({ updates, verdict, next: 'b' }, deepWrites, choices).ok).toBe(true);
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

describe('parseFieldInput / formatFieldInput', () => {
  it('reads a number, ignoring the spaces around it', () => {
    expect(parseFieldInput('number', ' 3 ')).toEqual(3);
  });

  it('reads an empty number as 0', () => {
    expect(parseFieldInput('number', '')).toEqual(0);
  });

  it('reads yes as true', () => {
    expect(parseFieldInput('boolean', 'yes')).toEqual(true);
  });

  it('reads no as false', () => {
    expect(parseFieldInput('boolean', 'no')).toEqual(false);
  });

  it('reads a comma list of text, dropping empty items', () => {
    expect(parseFieldInput('string[]', 'a, b,,c')).toEqual(['a', 'b', 'c']);
  });

  it('reads a list of text written as JSON', () => {
    expect(parseFieldInput('string[]', '["x y"]')).toEqual(['x y']);
  });

  it('reads a comma list of numbers', () => {
    expect(parseFieldInput('number[]', '1,2')).toEqual([1, 2]);
  });

  it('reads an object written as JSON', () => {
    expect(parseFieldInput('object', '{"a":1}')).toEqual({ a: 1 });
  });

  it('keeps text as typed, spaces and all', () => {
    expect(parseFieldInput('string', ' keep ')).toEqual(' keep ');
  });

  it('formats values back', () => {
    expect(formatFieldInput(['a', 'b'])).toBe('a, b');
    expect(formatFieldInput({ a: 1 })).toBe('{"a":1}');
    expect(formatFieldInput(undefined)).toBe('');
    expect(formatFieldInput(2)).toBe('2');
  });
});

describe('state values must be plain JSON', () => {
  it('rejects NaN inside number lists and non-JSON objects', () => {
    expect(checkValue('number[]', [1, NaN])).toMatch(/item 1 is NaN/);
    expect(checkValue('object', { at: new Date(0) })).toMatch(/Date/);
    expect(checkValue('object', { ok: [1, { a: 'b' }] })).toBeUndefined();
  });
});
