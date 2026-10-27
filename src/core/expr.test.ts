import { describe, expect, it } from 'vitest';
import { evalExpr, evaluateGuard, ExprError, exprFields, parseExpr } from './expr.js';

const state = {
  word: 'apple',
  guessed: ['a', 'e'],
  wrongCount: 2,
  maxWrong: 6,
  won: false,
  nested: { list: [{ name: 'x' }] },
  empty: '',
};

describe('evaluateGuard', () => {
  it.each([
    ['wrongCount < maxWrong', true],
    ['wrongCount >= maxWrong || won == true', false],
    ['!won && len(guessed) == 2', true],
    ['includes(guessed, "a")', true],
    ["includes(word, 'pp')", true],
    ['empty(empty) && !empty(word)', true],
    ['state.word == "apple"', true],
    ['nested.list[0].name == "x"', true],
    ['missing == null', false],
    ['len(missing) == 0', true],
    ['lower("ABC") == "abc"', true],
    ['(won || wrongCount > 1) && maxWrong != 5', true],
    ['wrongCount > -1', true],
  ])('%s -> %s', (src, expected) => {
    expect(evaluateGuard(src, state)).toBe(expected);
  });

  it('is strict about booleans and types', () => {
    expect(() => evaluateGuard('word', state)).toThrow(ExprError);
    expect(() => evaluateGuard('!word', state)).toThrow(ExprError);
    expect(() => evaluateGuard('word > 3', state)).toThrow(ExprError);
    expect(() => evaluateGuard('word && won', state)).toThrow(ExprError);
  });

  it('rejects bad syntax and unknown functions', () => {
    for (const bad of ['', 'a ==', 'eval(x)', 'a = b', '"open', 'len(a, b)', 'state', 'a b']) {
      expect(() => parseExpr(bad)).toThrow(ExprError);
    }
  });

  it('is deterministic across calls', () => {
    const src = 'len(guessed) > 1 && !won';
    expect(evaluateGuard(src, state)).toBe(evaluateGuard(src, state));
  });
});

describe('evalExpr values', () => {
  const ev = (src: string) => evalExpr(parseExpr(src), state);
  it.each([
    ['wrongCount + 1', 3],
    ['maxWrong - wrongCount - 1', 3],
    ['wrongCount -1', 1],
    ['word + "!"', 'apple!'],
    ['append(guessed, "z")', ['a', 'e', 'z']],
    ['if(includes(word, "z"), wrongCount, wrongCount + 1)', 3],
    ['chars("abc")', ['a', 'b', 'c']],
    ['subset(chars("aea"), guessed)', true],
    ['subset(chars(word), guessed)', false],
  ])('%s', (src, expected) => {
    expect(ev(src)).toEqual(expected);
  });

  it('only evaluates the taken if() branch', () => {
    expect(ev('if(true, 1, append(word, 1))')).toBe(1);
  });

  it('rejects mixed-type arithmetic', () => {
    expect(() => ev('word - 1')).toThrow(ExprError);
    expect(() => ev('word + 1')).toThrow(ExprError);
  });
});

describe('exprFields', () => {
  it('lists root identifiers', () => {
    expect(exprFields(parseExpr('state.a > 1 && includes(b, c.d) || !e')).toSorted()).toEqual([
      'a',
      'b',
      'c',
      'e',
    ]);
  });
});
