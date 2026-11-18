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

/** The error a call throws, or undefined when it returns. */
function thrown(call: () => unknown): unknown {
  try {
    call();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('evaluateGuard', () => {
  it('compares two numbers in state', () => {
    expect(evaluateGuard('wrongCount < maxWrong', state)).toBe(true);
  });

  it('an or of two false comparisons is false', () => {
    expect(evaluateGuard('wrongCount >= maxWrong || won == true', state)).toBe(false);
  });

  it('negation and len combine with and', () => {
    expect(evaluateGuard('!won && len(guessed) == 2', state)).toBe(true);
  });

  it('includes finds an item in a list', () => {
    expect(evaluateGuard('includes(guessed, "a")', state)).toBe(true);
  });

  it('includes finds a substring in single quotes', () => {
    expect(evaluateGuard("includes(word, 'pp')", state)).toBe(true);
  });

  it('empty is true for an empty string and false for a word', () => {
    expect(evaluateGuard('empty(empty) && !empty(word)', state)).toBe(true);
  });

  it('state.word reads the same field as word', () => {
    expect(evaluateGuard('state.word == "apple"', state)).toBe(true);
  });

  it("reads a nested list item's field by path", () => {
    expect(evaluateGuard('nested.list[0].name == "x"', state)).toBe(true);
  });

  it('a missing field does not equal null', () => {
    expect(evaluateGuard('missing == null', state)).toBe(false);
  });

  it('len of a missing field is 0', () => {
    expect(evaluateGuard('len(missing) == 0', state)).toBe(true);
  });

  it('lower lowercases text', () => {
    expect(evaluateGuard('lower("ABC") == "abc"', state)).toBe(true);
  });

  it('upper capitalises text', () => {
    expect(evaluateGuard('upper("abc") == "ABC"', state)).toBe(true);
  });

  it('upper capitalises each text of a list', () => {
    expect(evaluateGuard('upper(["security", "Tests"]) == ["SECURITY", "TESTS"]', state)).toBe(
      true,
    );
  });

  it('parentheses group an or inside an and', () => {
    expect(evaluateGuard('(won || wrongCount > 1) && maxWrong != 5', state)).toBe(true);
  });

  it('a negative number literal compares', () => {
    expect(evaluateGuard('wrongCount > -1', state)).toBe(true);
  });

  it('is strict about booleans and types', () => {
    expect(() => evaluateGuard('word', state)).toThrow(ExprError);
    expect(() => evaluateGuard('!word', state)).toThrow(ExprError);
    expect(() => evaluateGuard('word > 3', state)).toThrow(ExprError);
    expect(() => evaluateGuard('word && won', state)).toThrow(ExprError);
  });

  it('rejects bad syntax and unknown functions', () => {
    const bad = ['', 'a ==', 'eval(x)', 'a = b', '"open', 'len(a, b)', 'state', 'a b'];
    expect(bad.map((src) => thrown(() => parseExpr(src)))).toEqual(
      bad.map(() => expect.any(ExprError)),
    );
  });

  it('is deterministic across calls', () => {
    const src = 'len(guessed) > 1 && !won';
    expect(evaluateGuard(src, state)).toBe(evaluateGuard(src, state));
  });
});

describe('evalExpr values', () => {
  const ev = (src: string) => evalExpr(parseExpr(src), state);
  it('adds a number to a field', () => {
    expect(ev('wrongCount + 1')).toEqual(3);
  });

  it('subtracts left to right', () => {
    expect(ev('maxWrong - wrongCount - 1')).toEqual(3);
  });

  it("reads 'wrongCount -1' as a subtraction", () => {
    expect(ev('wrongCount -1')).toEqual(1);
  });

  it('concatenates text with +', () => {
    expect(ev('word + "!"')).toEqual('apple!');
  });

  it('append adds an item to a list', () => {
    expect(ev('append(guessed, "z")')).toEqual(['a', 'e', 'z']);
  });

  it('if returns the else branch when the condition is false', () => {
    expect(ev('if(includes(word, "z"), wrongCount, wrongCount + 1)')).toEqual(3);
  });

  it('chars splits text into characters', () => {
    expect(ev('chars("abc")')).toEqual(['a', 'b', 'c']);
  });

  it('subset is true when every character was guessed', () => {
    expect(ev('subset(chars("aea"), guessed)')).toEqual(true);
  });

  it('subset is false when a character was not guessed', () => {
    expect(ev('subset(chars(word), guessed)')).toEqual(false);
  });

  it('an empty list literal is an empty list', () => {
    expect(ev('[]')).toEqual([]);
  });

  it('an empty object literal is an empty object', () => {
    expect(ev('{}')).toEqual({});
  });

  it('if can return an object', () => {
    expect(ev('if(true, {}, 1)')).toEqual({});
  });

  it('a list literal holds numbers, fields and nested lists', () => {
    expect(ev('[1, word, [true]]')).toEqual([1, 'apple', [true]]);
  });

  it('take keeps the first n items', () => {
    expect(ev('take(guessed, 1)')).toEqual(['a']);
  });

  it('take stops at the end of a short list', () => {
    expect(ev('take(guessed, 5)')).toEqual(['a', 'e']);
  });

  it('drop removes the first n items', () => {
    expect(ev('drop(guessed, 1)')).toEqual(['e']);
  });

  it('drop past the end leaves an empty list', () => {
    expect(ev('drop(guessed, 9)')).toEqual([]);
  });

  it('first gives the first item', () => {
    expect(ev('first(guessed)')).toEqual('a');
  });

  it('unique keeps the first of each item, in order', () => {
    expect(ev('unique(guessed + ["a", "z", "z"])')).toEqual(['a', 'e', 'z']);
  });

  it('without removes the listed items', () => {
    expect(ev('without(guessed, ["a", "q"])')).toEqual(['e']);
  });

  it('get reads a key of an object', () => {
    expect(ev('get(nested, "list")')).toEqual([{ name: 'x' }]);
  });

  it('get reads an index of a list', () => {
    expect(ev('get(get(nested, "list"), 0)')).toEqual({ name: 'x' });
  });

  it('get of a missing key is null', () => {
    expect(ev('get(nested, "nope")')).toEqual(null);
  });

  it('get never reads an inherited property', () => {
    expect(ev('get(nested, "toString")')).toEqual(null);
  });

  it("keys lists an object's keys", () => {
    expect(ev('keys(nested)')).toEqual(['list']);
  });

  it('numbered prefixes findings with ids from a start number', () => {
    expect(ev('numbered(["a.ts:1 — x", "b.ts:2 — y"], 3)')).toEqual([
      'F3 a.ts:1 — x',
      'F4 b.ts:2 — y',
    ]);
  });

  it('unnumbered strips finding ids', () => {
    expect(ev('unnumbered(["F3 a.ts:1 — x", "plain"])')).toEqual(['a.ts:1 — x', 'plain']);
  });

  it('ids lists the finding ids found', () => {
    expect(ev('ids(["F3 a.ts:1 — x", "no id", "F10 c"])')).toEqual(['F3', 'F10']);
  });

  it('pick takes 1-based positions, skipping invalid ones', () => {
    expect(ev('pick(["a", "b", "c"], ["3", " 1", "9", "x", 2])')).toEqual(['c', 'a', 'b']);
  });

  it('join joins a list with a separator', () => {
    expect(ev('join(guessed, ", ")')).toEqual('a, e');
  });

  it('multiplication binds tighter than addition', () => {
    expect(ev('2 + 3 * 4')).toEqual(14);
  });

  it('parentheses group addition before multiplication', () => {
    expect(ev('(2 + 3) * 4')).toEqual(20);
  });

  it('join of an empty list is empty text', () => {
    expect(ev('join([], "-")')).toEqual('');
  });

  it('withIds keeps the findings whose ids are listed, in their order', () => {
    expect(ev('withIds(["F1 a", "F2 b", "F3 c"], ["F3", "F1", "F9"])')).toEqual(['F1 a', 'F3 c']);
  });

  it('unmatched keeps the lines that do not match a pattern', () => {
    expect(ev('unmatched(["S1: a", "b", "S12: c"], "^S[0-9]+: ")')).toEqual(['b']);
  });

  it('replace in a list rewrites the first match of each item', () => {
    expect(
      ev('replace(["F1 a.ts:1 — [BUG] [HIGH] x [HIGH]", "b"], "[[](HIGH|MEDIUM|LOW)]", "[LOW]")'),
    ).toEqual(['F1 a.ts:1 — [BUG] [LOW] x [HIGH]', 'b']);
  });

  it('replace inserts the replacement text literally', () => {
    expect(ev('replace("cost $5", "[0-9]+", "$&$1")')).toEqual('cost $$&$1');
  });

  it('text turns numbers and booleans into text', () => {
    expect(ev('"round " + text(2) + ", ok " + text(true)')).toEqual('round 2, ok true');
  });

  it('count counts the items that match a pattern', () => {
    expect(ev('count(["a.ts:1", "web | x", "b.ts:2"], "^[a-z.]+:[0-9]")')).toEqual(2);
  });

  it('positions gives the 1-based positions of matching items', () => {
    expect(ev('positions(["x", "binary", "y", "pdf"], "binary|pdf")')).toEqual([2, 4]);
  });

  it("heads gives each item's matching head, or empty text", () => {
    expect(ev('heads(["S2: a", "b", "S10: c"], "^S[0-9]+")')).toEqual(['S2', '', 'S10']);
  });

  it('pick with outside takes the positions not in a list', () => {
    expect(ev('pick(["r1", "r2", "r3"], outside(["a", "b", "c"], ["b"]))')).toEqual(['r1', 'r3']);
  });

  it('seq numbers a prefix from 1 to n', () => {
    expect(ev('seq("S", 3)')).toEqual(['S1', 'S2', 'S3']);
  });

  it('seq of 0 is an empty list', () => {
    expect(ev('seq("S", 0)')).toEqual([]);
  });

  it('lines splits text into lines', () => {
    expect(ev('lines("a\nb")')).toEqual(['a', 'b']);
  });

  it('lines of empty text is an empty list', () => {
    expect(ev('lines("")')).toEqual([]);
  });

  it('linesWith keeps the lines that contain a text', () => {
    expect(ev('linesWith(" ✓ a > t 1ms\n × a > u\n FAIL  a > u", "a > u")')).toEqual([
      ' × a > u',
      ' FAIL  a > u',
    ]);
  });

  it('count over lines finds an added .skip', () => {
    expect(ev('count(lines("+++ b/x\n+  it.skip(1)\n- old"), "^[+][^+].*[.]skip[(]")')).toEqual(1);
  });

  // Sentences over n words: headings and code are not sentences; each list line is one.
  it('longSentences finds sentences over n words, skipping headings and code', () => {
    expect(
      ev(
        'longSentences("## A very long heading that has many many words in it\n\nShort one. This one has seven words in it.\n- one two three four five six\n```\na b c d e f g h\n```", 5)',
      ),
    ).toEqual(['This one has seven words in it.', 'one two three four five six']);
  });

  it('longSentences of short sentences is an empty list', () => {
    expect(ev('longSentences("Fine. Also fine.", 5)')).toEqual([]);
  });

  it('diffLines keeps the changed lines of matching files', () => {
    expect(
      ev(
        'diffLines("diff --git a/src/a.ts b/src/a.ts\n+code\ndiff --git a/test/a.test.ts b/test/a.test.ts\n-old\n+new", "[.]test[.]")',
      ),
    ).toEqual(['-old', '+new']);
  });

  // Paths with spaces: read from the +++ line; an unparsed header never inherits the last file.
  it('diffLines reads a path with spaces from its +++ line', () => {
    expect(
      ev(
        'diffLines("diff --git a/src/a.ts b/src/a.ts\n+code\ndiff --git a/src/my thing.test.ts b/src/my thing.test.ts\n--- a/src/my thing.test.ts\n+++ b/src/my thing.test.ts\n@@ -1 +1 @@\n-it(\'a\')\n+it.skip(\'a\')", "[.]test[.]")',
      ),
    ).toEqual([
      '--- a/src/my thing.test.ts',
      '+++ b/src/my thing.test.ts',
      '@@ -1 +1 @@',
      "-it('a')",
      "+it.skip('a')",
    ]);
  });

  it('runsNeeded bounds a 10% failure rate for one candidate', () => {
    expect(ev('runsNeeded(0.1, 1)')).toEqual(29);
  });

  it('runsNeeded bounds a 10% failure rate shared by 8 candidates', () => {
    expect(ev('runsNeeded(0.1, 8)')).toEqual(49);
  });

  it('runsNeeded bounds a 25% failure rate shared by 8 candidates', () => {
    expect(ev('runsNeeded(0.25, 8)')).toEqual(18);
  });

  it('runsNeeded rounds up for a 13.3% failure rate and one candidate', () => {
    expect(ev('runsNeeded(0.133, 1)')).toEqual(21);
  });

  it('lists compare equal with ==', () => {
    expect(ev('heads(["S1: a", "S2: b"], "^S[0-9]+") == seq("S", 2)')).toEqual(true);
  });

  it('heads of different lines compare equal when their heads match', () => {
    expect(ev('heads(["S2: x"], "^S[0-9]+") == heads(["S2: y"], "^S[0-9]+")')).toEqual(true);
  });

  it("stances counts each hypothesis's for and against findings", () => {
    expect(
      ev(
        'stances(["F1 a.ts:1 — x [H1 for, H2 against]", "F2 b.ts:2 — y [h2 against]", "F3 c — z"], ["H1: a | c", "H2: b | c", "H3: none of these"])',
      ),
    ).toEqual([
      'H1: 1 for, 0 against',
      'H2: 0 for, 2 against — challenged',
      'H3: 0 for, 0 against — untested',
    ]);
  });

  it('pick with positions and unique picks each position once', () => {
    expect(ev('pick(["a", "b", "c"], unique(positions(["1", "2", "3"], "1|3") + [3]))')).toEqual([
      'a',
      'c',
    ]);
  });

  it('brief cuts each finding to n characters, ending in an ellipsis', () => {
    expect(
      ev('brief(["F1 a.ts:3 — the port `port = 8080`", "F2 long claim here", "F3 short"], 12)'),
    ).toEqual(['F1 a.ts:3 —…', 'F2 long cla…', 'F3 short']);
  });

  it('refs lists finding references once each, whole words only', () => {
    expect(ev('refs("Port 8081 [F2], see F10 and F2; not FF2 or F2x")')).toEqual(['F2', 'F10']);
  });

  it('refs reads a list of texts', () => {
    expect(ev('refs(["[F1]", "F1 and F3"])')).toEqual(['F1', 'F3']);
  });

  it('subset holds between refs and numbered ids', () => {
    expect(ev('subset(refs("[F1][F2]"), ids(numbered(["a", "b"], 1)))')).toEqual(true);
  });

  it('only evaluates the taken if() branch', () => {
    expect(ev('if(true, 1, append(word, 1))')).toBe(1);
  });

  it('rejects bad list function arguments', () => {
    expect(() => ev('first(drop(guessed, 2))')).toThrow(/empty list/);
    expect(() => ev('take(guessed, -1)')).toThrow(ExprError);
    expect(() => ev('take(word, 1)')).toThrow(ExprError);
    expect(() => ev('without(guessed, word)')).toThrow(ExprError);
    expect(() => ev('join([1, 2], ",")')).toThrow(/list of strings/);
    expect(() => ev('join(guessed, 1)')).toThrow(/separator/);
    expect(() => ev('unmatched(guessed, "(")')).toThrow(/invalid pattern/);
    expect(() => ev('replace("a", "(", "b")')).toThrow(/invalid pattern/);
  });

  it('rejects mixed-type arithmetic', () => {
    expect(() => ev('word - 1')).toThrow(ExprError);
    expect(() => ev('word + 1')).toThrow(ExprError);
    expect(() => ev('word * 2')).toThrow(/'\*' needs two numbers/);
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

const evaluate = (src: string, st: Record<string, unknown>) => evalExpr(parseExpr(src), st);

describe('flip-flops: a changed verdict needs new evidence; going back is UNKNOWN', () => {
  const st = {
    prev: ['H1: CONFIRMED — x [F2]', 'H2: REFUTED — y [F3]', 'H3: UNKNOWN — z'],
    first: ['H1: REFUTED — a [F1]', 'H2: REFUTED — b', 'H3: UNKNOWN — c'],
    now: [
      'H1: REFUTED — back again [F2]',
      'H2: CONFIRMED — new commit [F9]',
      'H3: CONFIRMED — same old [F3]',
    ],
    fresh: ['F8', 'F9'],
  };
  it('flipsWithout: changed verdicts citing none of the new ids', () => {
    expect(evaluate('flipsWithout(now, prev, fresh)', st)).toEqual([
      'H1: REFUTED — back again [F2]',
      'H3: CONFIRMED — same old [F3]',
    ]);
    // Unchanged, or new to the list: never a flip.
    expect(evaluate('flipsWithout(prev, prev, [])', st)).toEqual([]);
    expect(evaluate('flipsWithout(now, [], [])', st)).toEqual([]);
  });
  it('flipBacks: changed verdicts that return to what the first list said', () => {
    expect(evaluate('flipBacks(now, prev, first)', st)).toEqual(['H1: REFUTED — back again [F2]']);
  });
});
