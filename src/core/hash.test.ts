import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, HashError, hashOf, sha256, useSha256 } from './hash.js';

const nodeSha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('sha256', () => {
  it.each([
    '',
    'abc',
    'hello world',
    'ü✓ unicode',
    'x'.repeat(55),
    'y'.repeat(56),
    'z'.repeat(1000),
  ])('matches node:crypto for case %#', (input) => {
    expect(sha256(input)).toBe(nodeSha(input));
  });
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

describe('canonicalJson only accepts plain JSON', () => {
  it('refuses values that would collide with null or {}', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, () => 1, 1n]) {
      expect(() => canonicalJson(bad)).toThrow(HashError);
    }
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/\$\.at is a Date/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/Map/);
    expect(() => canonicalJson([1, undefined])).toThrow(/\$\[1\] is undefined/);
    expect(() => canonicalJson({ a: [{ b: NaN }] })).toThrow(/\$\.a\[0\]\.b is NaN/);
  });

  it('keeps hashes of valid JSON unchanged (saved runs still verify)', () => {
    expect(canonicalJson({ b: [1, 'x', null, true], a: { d: undefined, c: 2 } })).toBe(
      '{"a":{"c":2},"b":[1,"x",null,true]}',
    );
    expect(canonicalJson(Object.create(null))).toBe('{}');
  });
});

const native = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('useSha256', () => {
  it('a native SHA-256 gives every id unchanged', () => {
    const value = { b: [1, 'é 🎻'], a: { s: 'x\ud800' } };
    const before = hashOf(value);
    useSha256(native);
    try {
      expect(hashOf(value)).toBe(before);
    } finally {
      useSha256(sha256);
    }
  });

  it('refuses an implementation that is not SHA-256 of the UTF-8 bytes', () => {
    expect(() => useSha256((s) => createHash('sha1').update(s).digest('hex'))).toThrow(HashError);
    // Latin-1 instead of UTF-8 differs on non-ASCII text only: still caught.
    expect(() => useSha256((s) => createHash('sha256').update(s, 'latin1').digest('hex'))).toThrow(
      HashError,
    );
    expect(hashOf('x')).toBe(sha256(canonicalJson('x')));
  });
});
