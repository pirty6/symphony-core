import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanFact,
  LESSON_DAYS,
  MAX_FACTS_PER_RUN,
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

const many = (count: number, from = 0) =>
  Array.from(
    { length: count },
    (_, i) => `src/config.js:${i + from + 1} — line \`DEFAULTS.port + 1\``,
  );
const old = (text: string) => ({ text, at: '2026-01-01T00:00:00Z' });
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString();

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

  it('recalls lessons from earlier runs by shared words; gone files or old lessons are not recalled', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'src', 'paginate.ts'), 'export {};\n');
    await rememberLesson(
      ws,
      'Fixed "page 2 repeats an item": slice(start - 1)',
      ['src/paginate.ts'],
      day(2),
    );
    await rememberLesson(
      ws,
      'FAILED to fix "login timeout": flaky network',
      ['src/auth.ts'],
      day(1),
    );
    const r = await recall(ws, 'paginate shows a repeated item on page 2');
    expect(r.lessons).toEqual([
      `${day(2).slice(0, 10)} | Fixed "page 2 repeats an item": slice(start - 1)`,
    ]);
    // src/auth.ts does not exist: that lesson is about code that is gone.
    expect((await recall(ws, 'login timeout flaky network')).lessons).toEqual([]);
    await rememberLesson(
      ws,
      'Fixed "page 3 skips an item": old',
      ['src/paginate.ts'],
      day(LESSON_DAYS + 1),
    );
    expect((await recall(ws, 'page skips an item')).lessons.join()).not.toMatch(/old/);
  });

  it('a lesson keeps its run and file hashes; once a cited file changes it is not recalled', async () => {
    const ws = workspace();
    const store = workspace();
    writeFileSync(join(ws, 'src', 'paginate.ts'), 'export const page = 1;\n');
    const lesson = 'Answered "how does paginate count pages": from one';
    await rememberLesson(store, lesson, ['src/paginate.ts'], undefined, {
      run: 'r1',
      workspace: ws,
    });
    const saved = JSON.parse(readFileSync(memoryPath(store), 'utf8')).lessons[0];
    expect(saved.run).toBe('r1');
    expect(Object.keys(saved.hashes)).toEqual(['src/paginate.ts']);
    expect((await recall(ws, 'paginate count pages', 12, { store })).lessons).toHaveLength(1);
    writeFileSync(join(ws, 'src', 'paginate.ts'), 'export const page = 0;\n');
    expect((await recall(ws, 'paginate count pages', 12, { store })).lessons).toEqual([]);
  });

  it('stores facts without run annotations, one per path:line, the newest', async () => {
    const ws = workspace();
    expect(cleanFact('src/a.ts:3 — reads `arr[0]` first [H2 against] [F7]')).toBe(
      'src/a.ts:3 — reads `arr[0]` first',
    );
    await rememberFacts(
      ws,
      ['src/config.js:1 — the port is one more than the default `DEFAULTS.port + 1` [H1 for]'],
      '2026-01-01T00:00:00Z',
    );
    await rememberFacts(
      ws,
      ['F3 src/config.js:1 — adds one `DEFAULTS.port + 1` [H4 against]'],
      '2026-01-02T00:00:00Z',
    );
    const m = JSON.parse(readFileSync(memoryPath(ws), 'utf8')) as { facts: { text: string }[] };
    expect(m.facts.map((f) => f.text)).toEqual(['src/config.js:1 — adds one `DEFAULTS.port + 1`']);
  });

  it('one run adds at most MAX_FACTS_PER_RUN facts, so a few runs cannot replace the store', async () => {
    const ws = workspace();
    expect(await rememberFacts(ws, many(MAX_FACTS_PER_RUN + 50), undefined, 'run-a')).toBe(
      MAX_FACTS_PER_RUN,
    );
    expect(await rememberFacts(ws, many(10, 500), undefined, 'run-a')).toBe(0);
    expect(await rememberFacts(ws, many(10, 900), undefined, 'run-b')).toBe(10);
    const m = JSON.parse(readFileSync(memoryPath(ws), 'utf8')) as { facts: unknown[] };
    expect(m.facts).toHaveLength(MAX_FACTS_PER_RUN + 10);
  });

  it('a stored file from before the rules is tidied as it is read', async () => {
    const ws = workspace();
    mkdirSync(join(ws, '.symphony'), { recursive: true });
    writeFileSync(
      memoryPath(ws),
      JSON.stringify({
        facts: [
          old('src/config.js:1 — newest `DEFAULTS.port + 1` [H22 against]'),
          old('src/config.js:1 — older `DEFAULTS.port + 1` [H3 for]'),
        ],
        lessons: [],
      }),
    );
    await rememberLesson(ws, 'any write saves the tidy store', []);
    const m = JSON.parse(readFileSync(memoryPath(ws), 'utf8')) as { facts: { text: string }[] };
    expect(m.facts.map((f) => f.text)).toEqual(['src/config.js:1 — newest `DEFAULTS.port + 1`']);
  });

  it('ranks by rare shared words above common ones', async () => {
    const ws = workspace();
    const at = new Date().toISOString();
    for (let i = 0; i < 6; i += 1)
      await rememberLesson(ws, `Fixed "value returns early ${i}": config`, [], at);
    await rememberLesson(ws, 'Fixed "paginate drops the tail": slice', [], at);
    const r = await recall(ws, 'paginate value returns');
    expect(r.lessons[0]).toMatch(/paginate drops the tail/);
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
