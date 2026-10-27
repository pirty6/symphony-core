/**
 * Guard expressions: a tiny, safe, deterministic language for edge guards
 * and If nodes. No eval, no I/O, no implicit coercion.
 *
 *   wrongCount >= maxWrong || won == true
 *   !empty(word) && !includes(guessed, "e")
 *   len(findings) > 0 && state.confidence >= 0.8
 *
 * Identifiers resolve against the run state (`state.` prefix optional).
 * Logical operators require booleans; a guard must evaluate to a boolean.
 * Arithmetic: + (numbers, strings, lists) and - (numbers). List literals: [a, b].
 * Functions: len(x), empty(x), includes(listOrString, value), lower(s),
 *   append(list, v), if(cond, a, b), chars(s), subset(listA, listB),
 *   take(list, n), drop(list, n), first(list), unique(list), without(listA, listB),
 *   get(objectOrList, keyOrIndex) (null when missing), keys(object).
 */

export type Expr =
  | { readonly t: 'lit'; readonly v: unknown }
  | { readonly t: 'path'; readonly parts: readonly (string | number)[] }
  | { readonly t: 'not'; readonly e: Expr }
  | { readonly t: 'bin'; readonly op: BinOp; readonly l: Expr; readonly r: Expr }
  | { readonly t: 'call'; readonly fn: FnName; readonly args: readonly Expr[] }
  | { readonly t: 'list'; readonly items: readonly Expr[] };

type BinOp = '&&' | '||' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-';
type FnName =
  | 'len'
  | 'empty'
  | 'includes'
  | 'lower'
  | 'append'
  | 'if'
  | 'chars'
  | 'subset'
  | 'take'
  | 'drop'
  | 'first'
  | 'unique'
  | 'without'
  | 'get'
  | 'keys';

const FNS: Record<FnName, number> = {
  len: 1,
  empty: 1,
  includes: 2,
  lower: 1,
  append: 2,
  if: 3,
  chars: 1,
  subset: 2,
  take: 2,
  drop: 2,
  first: 1,
  unique: 1,
  without: 2,
  get: 2,
  keys: 1,
};

export class ExprError extends Error {
  override name = 'ExprError';
}

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'eof' };

const OPS = [
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '!',
  '(',
  ')',
  ',',
  '.',
  '[',
  ']',
  '+',
  '-',
];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const prev = out.at(-1);
    const afterValue =
      prev !== undefined &&
      (prev.k === 'num' ||
        prev.k === 'str' ||
        prev.k === 'id' ||
        (prev.k === 'op' && (prev.v === ')' || prev.v === ']')));
    if (/[0-9]/.test(c) || (c === '-' && !afterValue && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j += 1;
        s += src[j];
        j += 1;
      }
      if (j >= src.length) throw new ExprError(`unterminated string at ${i}`);
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected '${c}' at ${i}`);
    out.push({ k: 'op', v: op });
    i += op.length;
  }
  out.push({ k: 'eof' });
  return out;
}

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.k === 'op' && t.v === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected '${v}' at token ${pos}`);
    pos += 1;
  };

  const binary = (ops: readonly BinOp[], next: () => Expr, single = false): (() => Expr) => {
    return () => {
      let l = next();
      while (
        peek().k === 'op' &&
        (ops as readonly string[]).includes((peek() as { v: string }).v)
      ) {
        const op = (toks[pos++] as { v: string }).v as BinOp;
        l = { t: 'bin', op, l, r: next() };
        if (single) break;
      }
      return l;
    };
  };

  const primary = (): Expr => {
    const t = toks[pos++]!;
    if (t.k === 'num' || t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const e = orExpr();
      expectOp(')');
      return e;
    }
    if (t.k === 'op' && t.v === '[') {
      const items: Expr[] = [];
      if (!isOp(']')) {
        items.push(orExpr());
        while (isOp(',')) {
          pos += 1;
          items.push(orExpr());
        }
      }
      expectOp(']');
      return { t: 'list', items };
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') return { t: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (isOp('(')) {
        if (!(t.v in FNS)) throw new ExprError(`unknown function '${t.v}'`);
        pos += 1;
        const args: Expr[] = [];
        if (!isOp(')')) {
          args.push(orExpr());
          while (isOp(',')) {
            pos += 1;
            args.push(orExpr());
          }
        }
        expectOp(')');
        const fn = t.v as FnName;
        if (args.length !== FNS[fn]) {
          throw new ExprError(`${fn}() takes ${FNS[fn]} argument(s), got ${args.length}`);
        }
        return { t: 'call', fn, args };
      }
      const parts: (string | number)[] = t.v === 'state' ? [] : [t.v];
      for (;;) {
        if (isOp('.')) {
          pos += 1;
          const id = toks[pos++]!;
          if (id.k !== 'id') throw new ExprError(`expected property name after '.'`);
          parts.push(id.v);
        } else if (isOp('[')) {
          pos += 1;
          const idx = toks[pos++]!;
          if (idx.k !== 'num' && idx.k !== 'str') throw new ExprError('expected index literal');
          parts.push(idx.v);
          expectOp(']');
        } else break;
      }
      if (parts.length === 0) throw new ExprError(`'state' must be followed by a field`);
      return { t: 'path', parts };
    }
    throw new ExprError(`unexpected token at ${pos - 1}`);
  };

  const unary = (): Expr => {
    if (isOp('!')) {
      pos += 1;
      return { t: 'not', e: unary() };
    }
    return primary();
  };
  const addExpr = binary(['+', '-'], unary);
  const cmpExpr = binary(['==', '!=', '<', '<=', '>', '>='], addExpr, true);
  const andExpr = binary(['&&'], cmpExpr);
  const orExpr: () => Expr = binary(['||'], andExpr);

  if (src.trim() === '') throw new ExprError('empty expression');
  const e = orExpr();
  if (peek().k !== 'eof') throw new ExprError(`unexpected trailing input at token ${pos}`);
  return e;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireBool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new ExprError(`${what} must be boolean, got ${typeof v}`);
  return v;
}

export function evalExpr(e: Expr, state: Readonly<Record<string, unknown>>): unknown {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'list':
      return e.items.map((i) => evalExpr(i, state));
    case 'path': {
      let cur: unknown = state;
      for (const p of e.parts) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string | number, unknown>)[p];
      }
      return cur;
    }
    case 'not':
      return !requireBool(evalExpr(e.e, state), "operand of '!'");
    case 'call': {
      if (e.fn === 'if') {
        const cond = requireBool(evalExpr(e.args[0]!, state), 'if() condition');
        return evalExpr(cond ? e.args[1]! : e.args[2]!, state);
      }
      const args = e.args.map((a) => evalExpr(a, state));
      const x = args[0];
      switch (e.fn) {
        case 'len':
          if (typeof x === 'string' || Array.isArray(x)) return x.length;
          if (x && typeof x === 'object') return Object.keys(x).length;
          return 0;
        case 'empty':
          if (x === null || x === undefined || x === '') return true;
          if (Array.isArray(x)) return x.length === 0;
          if (typeof x === 'object') return Object.keys(x).length === 0;
          return false;
        case 'includes':
          if (Array.isArray(x)) return x.some((v) => deepEqual(v, args[1]));
          if (typeof x === 'string' && typeof args[1] === 'string') return x.includes(args[1]);
          return false;
        case 'lower':
          return typeof x === 'string' ? x.toLowerCase() : x;
        case 'append':
          if (!Array.isArray(x)) throw new ExprError('append() needs a list as first argument');
          return [...x, args[1]];
        case 'chars':
          if (typeof x !== 'string') throw new ExprError('chars() needs a string');
          return [...x];
        case 'subset': {
          const y = args[1];
          if (!Array.isArray(x) || !Array.isArray(y))
            throw new ExprError('subset() needs two lists');
          return x.every((v) => y.some((w) => deepEqual(v, w)));
        }
        case 'take':
        case 'drop': {
          const n = args[1];
          if (!Array.isArray(x)) throw new ExprError(`${e.fn}() needs a list`);
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
            throw new ExprError(`${e.fn}() needs a non-negative integer count`);
          }
          return e.fn === 'take' ? x.slice(0, n) : x.slice(n);
        }
        case 'first':
          if (!Array.isArray(x)) throw new ExprError('first() needs a list');
          if (x.length === 0) throw new ExprError('first() of an empty list');
          return x[0];
        case 'unique':
          if (!Array.isArray(x)) throw new ExprError('unique() needs a list');
          return x.filter((v, i) => x.findIndex((w) => deepEqual(v, w)) === i);
        case 'get': {
          const k = args[1];
          if (Array.isArray(x)) return typeof k === 'number' ? (x[k] ?? null) : null;
          if (x && typeof x === 'object' && (typeof k === 'string' || typeof k === 'number')) {
            return Object.hasOwn(x, k) ? (x as Record<string, unknown>)[k] : null;
          }
          return null;
        }
        case 'keys':
          if (!x || typeof x !== 'object' || Array.isArray(x))
            throw new ExprError('keys() needs an object');
          return Object.keys(x).toSorted();
        case 'without': {
          const y = args[1];
          if (!Array.isArray(x) || !Array.isArray(y))
            throw new ExprError('without() needs two lists');
          return x.filter((v) => !y.some((w) => deepEqual(v, w)));
        }
      }
      break;
    }
    case 'bin': {
      if (e.op === '&&') {
        return (
          requireBool(evalExpr(e.l, state), "left of '&&'") &&
          requireBool(evalExpr(e.r, state), "right of '&&'")
        );
      }
      if (e.op === '||') {
        return (
          requireBool(evalExpr(e.l, state), "left of '||'") ||
          requireBool(evalExpr(e.r, state), "right of '||'")
        );
      }
      const l = evalExpr(e.l, state);
      const r = evalExpr(e.r, state);
      if (e.op === '+') {
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        if (typeof l === 'string' && typeof r === 'string') return l + r;
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        throw new ExprError(
          `'+' needs two numbers, strings or lists, got ${typeof l} and ${typeof r}`,
        );
      }
      if (e.op === '-') {
        if (typeof l === 'number' && typeof r === 'number') return l - r;
        throw new ExprError(`'-' needs two numbers, got ${typeof l} and ${typeof r}`);
      }
      if (e.op === '==') return deepEqual(l, r);
      if (e.op === '!=') return !deepEqual(l, r);
      const bothNum = typeof l === 'number' && typeof r === 'number';
      const bothStr = typeof l === 'string' && typeof r === 'string';
      if (!bothNum && !bothStr) {
        throw new ExprError(
          `'${e.op}' needs two numbers or two strings, got ${typeof l} and ${typeof r}`,
        );
      }
      const a = l as number | string;
      const b = r as number | string;
      if (e.op === '<') return a < b;
      if (e.op === '<=') return a <= b;
      if (e.op === '>') return a > b;
      return a >= b;
    }
  }
  throw new ExprError('unreachable');
}

export function evaluateGuard(src: string, state: Readonly<Record<string, unknown>>): boolean {
  return requireBool(evalExpr(parseExpr(src), state), `guard '${src}'`);
}

/** Root identifiers an expression reads; used to validate guards against the state schema. */
export function exprFields(e: Expr): string[] {
  const out = new Set<string>();
  const walk = (x: Expr): void => {
    if (x.t === 'path' && typeof x.parts[0] === 'string') out.add(x.parts[0]);
    if (x.t === 'not') walk(x.e);
    if (x.t === 'bin') {
      walk(x.l);
      walk(x.r);
    }
    if (x.t === 'call') x.args.forEach(walk);
    if (x.t === 'list') x.items.forEach(walk);
  };
  walk(e);
  return [...out];
}
