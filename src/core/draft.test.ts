import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fix, hangman } from '../patterns/index.js';
import { camelName, draftInstructions, parseDraft, patternToTypeScript } from './draft.js';
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
