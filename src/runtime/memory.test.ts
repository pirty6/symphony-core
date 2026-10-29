import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  memoryPath,
  recall,
  recallCompositions,
  rememberComposition,
  rememberFacts,
  rememberLesson,
} from './memory.js';

const root = mkdtempSync(join(tmpdir(), 'symphony-memory-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function workspace() {
  const ws = join(root, `w${n++}`);
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'config.js'), 'export const port = DEFAULTS.port + 1;\n');
  writeFileSync(join(ws, 'src', 'log.js'), 'export const level = "info";\n');
  return ws;
}

describe('memory across runs', () => {
  it('keeps checked facts that quote the file, and recalls the ones about the question', async () => {
    const ws = workspace();
    const kept = await rememberFacts(ws, [
      'F3 src/config.js:1 — the port is the default plus one `DEFAULTS.port + 1`',
      'src/log.js:1 — the log level defaults to info `level = "info"`',
      'src/config.js:1 — no quote, cannot be re-checked',
      'web | https://example.com — a page',
    ]);
    expect(kept).toBe(2);
    const r = await recall(ws, 'Which port does the server use by default?');
    expect(r.facts).toEqual([
      'src/config.js:1 — the port is the default plus one `DEFAULTS.port + 1`',
    ]);
    expect((await recall(ws, 'unrelated words entirely')).facts).toEqual([]);
  });

  it('never offers a fact about code that has changed since', async () => {
    const ws = workspace();
    await rememberFacts(ws, ['src/config.js:1 — port is default plus one `DEFAULTS.port + 1`']);
    writeFileSync(join(ws, 'src', 'config.js'), 'export const port = 3000;\n');
    expect((await recall(ws, 'default port')).facts).toEqual([]);
  });

  it('recalls lessons from earlier runs by shared words, newest wins on ties', async () => {
    const ws = workspace();
    await rememberLesson(
      ws,
      'Fixed "page 2 repeats an item": slice(start - 1)',
      ['src/paginate.ts'],
      '2026-01-01T00:00:00Z',
    );
    await rememberLesson(
      ws,
      'FAILED to fix "login timeout": flaky network',
      ['src/auth.ts'],
      '2026-01-02T00:00:00Z',
    );
    const r = await recall(ws, 'paginate shows a repeated item on page 2');
    expect(r.lessons).toEqual(['2026-01-01 | Fixed "page 2 repeats an item": slice(start - 1)']);
  });

  it('parallel writers leave a readable file', async () => {
    const ws = workspace();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => rememberLesson(ws, `lesson ${i} about ports`, [])),
    );
    const saved = JSON.parse(readFileSync(memoryPath(ws), 'utf8')) as { lessons: unknown[] };
    expect(saved.lessons).toHaveLength(8);
  });
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
