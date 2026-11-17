import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryPath, recallCompositions, rememberComposition } from './memory.js';

const root = mkdtempSync(join(tmpdir(), 'symphony-memory-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const workspace = () => join(root, `w${n++}`);
const composition = (request: string) => ({
  request,
  chosen: 'fix',
  complexity: 2,
  thenPattern: '',
  adaptation: {},
  pattern: {},
  template: 'fix-v1',
});

describe('remembered compositions', () => {
  const ws = mkdtempSync(join(tmpdir(), 'symphony-compositions-'));
  afterAll(() => rmSync(ws, { recursive: true, force: true }));
  const base = { complexity: 3, thenPattern: '', pattern: {}, template: 'fix-v1' };
  const fingerprints: Record<string, string> = { fix: 'fix-v1', investigate: 'inv-v1' };
  const fp = (name: string) => fingerprints[name];

  it('the same request reuses the approved composition; similar ones are precedent', async () => {
    await rememberComposition(
      ws,
      {
        ...base,
        request: 'Fix the flaky login test on CI',
        chosen: 'fix',
        adaptation: { directives: { hypothesize: 'timing' } },
      },
      '2026-01-01T00:00:00Z',
    );
    await rememberComposition(
      ws,
      {
        ...base,
        request: 'Why is checkout slow on mobile?',
        chosen: 'investigate',
        template: 'inv-v1',
        adaptation: {},
        thenPattern: 'fix',
      },
      '2026-01-02T00:00:00Z',
    );
    const same = await recallCompositions(ws, '  fix the FLAKY login test on ci ', fp);
    expect(same.exact).toMatchObject({
      chosen: 'fix',
      adaptation: { directives: { hypothesize: 'timing' } },
    });
    expect(same.similar).toEqual([]);
    const near = await recallCompositions(ws, 'Fix the flaky signup test on CI', fp);
    expect(near.exact).toBeUndefined();
    expect(near.similar).toEqual([
      expect.stringMatching(
        /^2026-01-01 \| "Fix the flaky login test on CI" → fix \(complexity 3\); adaptation \{"directives"/,
      ),
    ]);
    expect((await recallCompositions(ws, 'checkout slow', fp)).similar[0]).toMatch(
      /→ investigate \(complexity 3, then fix\)/,
    );
  });

  it('is not reused as is once its pattern changed, or left the library', async () => {
    expect(
      (await recallCompositions(ws, 'Fix the flaky login test on CI', () => 'fix-v2')).exact,
    ).toBeUndefined();
    expect(
      (await recallCompositions(ws, 'Fix the flaky login test on CI', () => undefined)).exact,
    ).toBeUndefined();
  });

  it('keeps the newest per request and pattern; a new pattern is reused by its definition', async () => {
    await rememberComposition(ws, {
      ...base,
      request: 'fix the flaky login test on CI',
      chosen: 'fix',
      adaptation: { initial: { maxAttempts: 1 } },
    });
    const m = JSON.parse(readFileSync(memoryPath(ws), 'utf8')) as { compositions: unknown[] };
    expect(m.compositions).toHaveLength(2);
    expect(
      (await recallCompositions(ws, 'Fix the flaky login test on CI', fp)).exact?.adaptation,
    ).toEqual({
      initial: { maxAttempts: 1 },
    });
    await rememberComposition(ws, {
      ...base,
      request: 'Compose a haiku about the build',
      chosen: 'new',
      adaptation: {},
      template: '',
      pattern: { name: 'haiku' },
    });
    expect(
      (await recallCompositions(ws, 'compose a haiku about the build', fp)).exact,
    ).toMatchObject({
      chosen: 'new',
      pattern: { name: 'haiku' },
    });
  });
});

describe('the memory file', () => {
  it('parallel writers leave a readable file', async () => {
    const ws = workspace();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => rememberComposition(ws, composition(`request ${i}`))),
    );
    const saved = JSON.parse(readFileSync(memoryPath(ws), 'utf8')) as { compositions: unknown[] };
    expect(saved.compositions).toHaveLength(8);
  });

  it('a store from before keeps its compositions and drops the facts and lessons at the next save', async () => {
    const ws = workspace();
    mkdirSync(dirname(memoryPath(ws)), { recursive: true });
    writeFileSync(
      memoryPath(ws),
      JSON.stringify({
        facts: [{ text: 'a.ts:1 — old `x`', at: '2026-01-01T00:00:00Z' }],
        lessons: [{ text: 'Fixed "old"', at: '2026-01-01T00:00:00Z' }],
        compositions: [{ ...composition('old request'), at: '2026-01-01T00:00:00Z' }],
      }),
    );
    await rememberComposition(ws, composition('new request'));
    const saved = JSON.parse(readFileSync(memoryPath(ws), 'utf8')) as Record<string, unknown[]>;
    expect(Object.keys(saved)).toEqual(['compositions']);
    expect(saved.compositions!.map((c) => (c as { request: string }).request)).toEqual([
      'new request',
      'old request',
    ]);
  });

  it('a memory file that cannot be read is never overwritten', async () => {
    const ws = workspace();
    mkdirSync(dirname(memoryPath(ws)), { recursive: true });
    writeFileSync(memoryPath(ws), '{ broken');
    // Reading still works (nothing recalled); writing refuses instead of wiping it.
    expect((await recallCompositions(ws, 'fix it', () => 'fix-v1')).similar).toEqual([]);
    await expect(rememberComposition(ws, composition('fix it'))).rejects.toThrow(
      /not valid JSON; not overwriting it/,
    );
    expect(readFileSync(memoryPath(ws), 'utf8')).toBe('{ broken');
  });

  it('a composition whose request holds a token is written scrubbed', async () => {
    const ws = workspace();
    // Built at run time: no literal a secret scanner would flag.
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    await rememberComposition(ws, composition(`deploy with GITHUB_TOKEN=${token}`));
    const text = readFileSync(memoryPath(ws), 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain('[REDACTED:github-token]');
  });
});
