import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashOf, sha256 } from './hash.js';

const nodeSha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('sha256', () => {
  it.each(['', 'abc', 'hello world', 'ü✓ unicode', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000)])(
    'matches node:crypto for case %#',
    (input) => {
      expect(sha256(input)).toBe(nodeSha(input));
    },
  );
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"x":0,"y":1}]},"b":1}',
    );
  });

  it('hashOf is key-order independent', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});
