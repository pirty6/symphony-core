import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fix, hangman, investigate, PATTERNS } from '../patterns/index.js';
import { CompileError, compileScore } from './compile.js';
import { validatePattern } from './validate.js';
import {
  adaptPattern,
  MAX_GUIDANCE,
  camelName,
  draftInstructions,
  genericDraft,
  outlinePattern,
  parseDraft,
  patternToTypeScript,
  summarizeComposed,
} from './draft.js';
import type { Pattern } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'symphony-draft-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const asJson = (p: Pattern) => JSON.parse(JSON.stringify({ ...p, demo: undefined })) as unknown;

describe('parseDraft', () => {
  it('accepts a JSON round-trip of a valid pattern', () => {
    const r = parseDraft(asJson(fix));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.nodes).toEqual(fix.nodes);
  });

  // The maestro re-parses every score it composes: a field dropped here silently changes how
  // the composed run plays (fewer sub-agents, no warm-up, no engine record of partial reads).
  it.each(PATTERNS.map((p) => [p.name, p] as const))(
    '%s survives the round trip the maestro gives it, field for field',
    (_n, p) => {
      const json = asJson(p);
      const r = parseDraft(json);
      expect(r.ok).toBe(true);
      if (r.ok) expect(JSON.parse(JSON.stringify(r.value))).toEqual(json);
    },
  );

  it('collects structural and graph errors', () => {
    const r = parseDraft({
      name: 'Bad Name',
      state: [{ name: 'x', type: 'date' }],
      nodes: [{ id: 's', kind: 'start' }, { id: 'a', kind: 'robot' }, { kind: 'end' }],
      edges: [{ from: 's' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const m = r.errors.join('\n');
      expect(m).toMatch(/state\[0\] needs name and a type/);
      expect(m).toMatch(/unknown kind 'robot'/);
      expect(m).toMatch(/nodes\[2\].id is required/);
      expect(m).toMatch(/edges\[0\] needs from and to/);
      expect(m).toMatch(/kebab-case/);
    }
  });

  it('rejects non-objects', () => {
    expect(parseDraft('flow please').ok).toBe(false);
  });

  it('documents every node kind in the drafting instructions', () => {
    const text = draftInstructions();
    for (const k of ['start', 'agent', 'compute', 'condition', 'approval', 'end'])
      expect(text).toContain(`kind:"${k}"`);
  });
});

/** hangman with one more state field: what validation says about it. */
const field = (f: object) =>
  validatePattern({
    ...hangman,
    state: [...hangman.state, { name: 'x', ...f }],
  } as Pattern).errors.map((e) => e.message);

describe('adaptPattern', () => {
  const base = parseDraft(genericDraft('find the flaky test'));
  if (!base.ok) throw new Error(base.errors.join());
  const p = {
    ...base.value,
    state: [
      ...base.value.state,
      { name: 'maxRounds', type: 'number' as const, initial: 3 },
      { name: 'deep', type: 'boolean' as const, description: 'Read everything' },
    ],
  };
  const agent = p.nodes.find((n) => n.kind === 'agent')!;
  const other = p.nodes.find((n) => n.kind !== 'agent')!;

  it('appends guidance to agent steps and sets initial values; the shape stays as it was', () => {
    const { pattern, errors } = adaptPattern(p, {
      directives: { [agent.id]: 'Start from PR 5923334.' },
      initial: { maxRounds: 1, deep: true },
    });
    expect(errors).toEqual([]);
    const adapted = pattern.nodes.find((n) => n.id === agent.id) as { directive: string };
    expect(adapted.directive).toBe(
      `${(agent as { directive: string }).directive}\n\nFor this request: Start from PR 5923334.`,
    );
    expect(pattern.state.find((f) => f.name === 'maxRounds')!.initial).toBe(1);
    expect(pattern.nodes.map((n) => n.id)).toEqual(p.nodes.map((n) => n.id));
    expect(pattern.edges).toBe(p.edges);
    expect(parseDraft(pattern).ok).toBe(true);
  });

  it('rejects what does not fit instead of guessing', () => {
    const { errors } = adaptPattern(p, {
      directives: { nope: 'x', [other.id]: 'x', [agent.id]: '  ' },
      initial: { maxRounds: 'two', missing: 1 },
      nodes: [],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/adaptation\.nodes: only "directives" and "initial"/),
        expect.stringMatching(/no step 'nope'/),
        expect.stringMatching(new RegExp(`'${other.id}' is a ${other.kind} step`)),
        expect.stringMatching(/guidance must be non-empty/),
        expect.stringMatching(/adaptation\.initial\.maxRounds:/),
        expect.stringMatching(/no state key 'missing'/),
      ]),
    );
    expect(adaptPattern(p, 'rewrite it').errors).toEqual([
      expect.stringMatching(/must be an object/),
    ]);
    expect(adaptPattern(p, {}).errors).toEqual([]);
    // Guidance may bound experiments and web research, never rule them out (seen live: a run
    // told "do not plan experiments" left every runtime question unverified).
    for (const text of [
      'Do not plan experiments that rerun the test suite to measure the flake rate.',
      'Skip web research; the code says enough.',
      'Avoid any experiments.',
    ])
      expect(adaptPattern(p, { directives: { [agent.id]: text } }).errors).toEqual([
        expect.stringMatching(/must not rule out experiments or web research \("/),
      ]);
    for (const text of [
      'Run only the three flaky specs, 30 times each with retries off; never the whole suite.',
      'No need to read the vendor docs twice.',
    ])
      expect(adaptPattern(p, { directives: { [agent.id]: text } }).errors).toEqual([]);
    // Too long is refused by name, never cut silently.
    const long = 'x'.repeat(MAX_GUIDANCE + 1);
    expect(adaptPattern(p, { directives: { [agent.id]: long } }).errors).toEqual([
      `adaptation.directives.${agent.id}: guidance is ${MAX_GUIDANCE + 1} characters, over ${MAX_GUIDANCE}: shorten it (keep what the step must do differently for this request)`,
    ]);
    const fits = adaptPattern(p, { directives: { [agent.id]: 'y'.repeat(MAX_GUIDANCE) } });
    expect(fits.pattern.nodes.find((n) => n.id === agent.id)).toMatchObject({
      directive: expect.stringMatching(new RegExp(`y{${MAX_GUIDANCE}}$`)),
    });
  });

  it('a setting may not go below its declared minimum: experiments cannot be tailored off', () => {
    // Regression: a tailoring set maxExperiments to 0; the design step then had to give at
    // least one experiment and at most none, and the run was stuck there.
    expect(adaptPattern(investigate, { initial: { maxExperiments: 0 } }).errors).toEqual([
      'adaptation.initial.maxExperiments: must be at least 1, got 0',
    ]);
    expect(adaptPattern(investigate, { initial: { maxExperiments: 3 } }).errors).toEqual([]);
    // The maestro is told, and so is every other way in: run inputs are checked at compile.
    expect(outlinePattern(investigate).settings).toContainEqual(
      expect.stringMatching(/^maxExperiments = 12 \(at least 1\) — /),
    );
    expect(() =>
      compileScore(investigate, { context: { question: 'q', maxExperiments: 0 } }),
    ).toThrow(CompileError);
    expect(() =>
      compileScore(investigate, { context: { question: 'q', maxExperiments: 0 } }),
    ).toThrow(/context 'maxExperiments': must be at least 1, got 0/);
    // A pattern's own default must meet it, and only numbers have one.
    expect(field({ type: 'number', initial: 0, min: 1 })).toContainEqual(
      expect.stringMatching(/'x' initial value: must be at least 1/),
    );
    expect(field({ type: 'string', min: 1 })).toContainEqual(
      expect.stringMatching(/min is for number fields/),
    );
    // A cap too: more than 6 parallel sub-agents does nothing, so it is refused.
    expect(adaptPattern(investigate, { initial: { agentsCap: 8 } }).errors).toEqual([
      'adaptation.initial.agentsCap: must be at most 6, got 8',
    ]);
    expect(outlinePattern(investigate).settings).toContainEqual(
      expect.stringMatching(/^agentsCap = 6 \(1 to 6\) — /),
    );
    // Values the engine derives after planning are not offered as settings.
    const names = outlinePattern(investigate).settings.map((x) => x.split(' ')[0]);
    expect(names).not.toContain('batchWave');
    expect(names).not.toContain('deepWave');
    expect(field({ type: 'number', min: 3, max: 2 })).toContainEqual(
      "state field 'x': min is above max",
    );
    // Kept by a draft round-trip.
    const parsed = parseDraft(JSON.parse(JSON.stringify(investigate)));
    expect(parsed.ok && parsed.value.state.find((f) => f.name === 'maxExperiments')?.min).toBe(1);
  });

  it('outlines a pattern in a fraction of its size, with its tunable settings', () => {
    const { steps, settings } = outlinePattern(p);
    expect(steps).toHaveLength(p.nodes.length);
    expect(steps.find((s) => s.startsWith(`${agent.id} (agent`))).toBeDefined();
    expect(settings).toEqual(
      expect.arrayContaining(['maxRounds = 3', 'deep = false — Read everything']),
    );
  });
});

describe('patternToTypeScript', () => {
  it('emits an importable module equal to the pattern minus demo', async () => {
    const file = join(dir, 'hangman.ts');
    writeFileSync(file, patternToTypeScript(hangman));
    const mod = (await import(pathToFileURL(file).href)) as Record<string, Pattern>;
    const { demo: _d, ...expected } = hangman;
    expect(mod.hangman).toEqual(expected);
  });

  it('escapes quotes and newlines', async () => {
    const p: Pattern = { ...fix, name: 'odd-one', description: "it's */ tricky", demo: undefined };
    const file = join(dir, 'odd.ts');
    writeFileSync(file, patternToTypeScript(p));
    const mod = (await import(pathToFileURL(file).href)) as Record<string, Pattern>;
    expect(mod.oddOne?.description).toBe("it's */ tricky");
    expect(mod.oddOne?.nodes).toEqual(fix.nodes);
  });

  it('camelCases names', () => {
    expect(camelName('fix-flaky-tests')).toBe('fixFlakyTests');
    expect(camelName('2-step')).toBe('p2Step');
  });

  it('cannot be tricked into emitting code through keys or strings', async () => {
    const evil = "x': 0, y: (globalThis.pwnedByCodegen = 'yes'), 'z";
    const p: Pattern = {
      ...fix,
      name: 'evil-keys',
      demo: undefined,
      description: 'line\rsep\u2028end',
      state: [...fix.state, { name: 'blob', type: 'object', initial: { [evil]: 1, "a'b\n": 'c' } }],
    };
    const file = join(dir, 'evil.ts');
    writeFileSync(file, patternToTypeScript(p));
    const mod = (await import(pathToFileURL(file).href)) as Record<string, Pattern>;
    expect((globalThis as Record<string, unknown>).pwnedByCodegen).toBeUndefined();
    expect(mod.evilKeys?.state.at(-1)?.initial).toEqual({ [evil]: 1, "a'b\n": 'c' });
    expect(mod.evilKeys?.description).toBe('line\rsep\u2028end');
  });

  it('parses tool nodes, checks and capabilities', () => {
    const r = parseDraft({
      name: 'scan',
      description: 'scan',
      requiredContext: [],
      state: [
        { name: 'files', type: 'string[]' },
        { name: 'seen', type: 'string[]' },
      ],
      start: 's',
      nodes: [
        { id: 's', kind: 'start', label: 'S' },
        {
          id: 'list',
          kind: 'tool',
          label: 'L',
          tool: 'repo.files',
          output: { files: 'files', junk: 3 },
        },
        {
          id: 'a',
          kind: 'agent',
          role: 'assessor',
          label: 'A',
          directive: 'd',
          reads: ['files'],
          writes: ['seen'],
          capabilities: ['web'],
          checks: [{ expr: 'subset(files, seen)', message: 'all' }],
        },
        { id: 'e', kind: 'end', label: 'E' },
      ],
      edges: [
        { from: 's', to: 'list' },
        { from: 'list', to: 'a' },
        { from: 'a', to: 'e' },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[1]).toEqual({
        id: 'list',
        kind: 'tool',
        label: 'L',
        tool: 'repo.files',
        output: { files: 'files' },
      });
      expect(r.value.nodes[2]).toMatchObject({
        capabilities: ['web'],
        checks: [{ expr: 'subset(files, seen)', message: 'all' }],
      });
    }
  });
});

describe('summarizeComposed', () => {
  const steps = fix.nodes.length - 1;
  const ai = fix.nodes.filter((n) => n.kind === 'agent').length;
  const base = { normalized: fix, chosen: 'fix', draft: {} };

  it('says a tailored library pattern is the tested pattern, not a new one', () => {
    const s = summarizeComposed({
      ...base,
      adaptation: { directives: { diagnose: 'x', plan: 'y' }, initial: { maxAttempts: 3 } },
    })!;
    expect(s).toMatchObject({ kind: 'tailored', steps, aiSteps: ai, guided: ['diagnose', 'plan'] });
    expect(s.headline).toBe(
      `fix: the tested library pattern (${steps} steps, ${ai} AI), with guidance for this request on 2 AI steps and 1 setting changed; its steps are unchanged`,
    );
  });

  it('tells apart the pattern as is, a rewrite and a new pattern', () => {
    expect(summarizeComposed({ ...base, adaptation: {} })!.kind).toBe('library');
    expect(summarizeComposed({ ...base, draft: { name: 'fix' } })!.kind).toBe('rewritten');
    expect(summarizeComposed({ ...base, chosen: 'new' })!.headline).toMatch(
      /a new pattern composed/,
    );
    expect(summarizeComposed({})).toBeUndefined();
  });
});
