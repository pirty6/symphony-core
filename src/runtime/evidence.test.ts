import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkCitations } from './evidence.js';

const ws = mkdtempSync(join(tmpdir(), 'symphony-evidence-'));
afterAll(() => rmSync(ws, { recursive: true, force: true }));
mkdirSync(join(ws, 'src'));
writeFileSync(
  join(ws, 'README.md'),
  ['# demo', '', 'Run `npm start` to open the **studio** on port 5173.', ''].join('\n'),
);
writeFileSync(
  join(ws, 'src', 'config.js'),
  ['// config', 'export const config = {', '  port: Number(process.env.PORT ?? 8080),', '};'].join(
    '\n',
  ),
);

describe('checkCitations', () => {
  it('keeps real quoted citations and passes other sources through', async () => {
    const r = await checkCitations(ws, [
      'src/config.js:3 — the default port is 8080 `port: Number(process.env.PORT ?? 8080)`',
      'F7 src/config.js:2-3 — config is a plain object `export const config = {`',
      'web | https://nodejs.org/api/process.html — env values are strings',
      'git | a1b2c3 — port default added',
    ]);
    expect(r.invalid).toEqual([]);
    expect(r.valid).toHaveLength(4);
    expect(r.checked).toBe(2);
  });

  it('rejects a missing file, a line past the end, and a quote that is not there', async () => {
    const r = await checkCitations(ws, [
      'src/server.js:4 — listens on config.port',
      'src/config.js:40 — reads PORT',
      'src/config.js:3 — the default is 3000 `process.env.PORT ?? 3000`',
      '../outside.txt:1 — escapes the workspace',
    ]);
    expect(r.valid).toEqual([]);
    expect(r.invalid.map((i) => i.reason)).toEqual([
      'src/server.js does not exist in the workspace',
      'src/config.js has 4 lines, not line 40',
      'the quote `process.env.PORT ?? 3000` is not at src/config.js:3',
      '../outside.txt does not exist in the workspace',
    ]);
  });

  it('allows a quote a few lines off and ignores whitespace differences', async () => {
    const r = await checkCitations(ws, ['src/config.js:1 — `port:   Number(process.env.PORT`']);
    expect(r.invalid).toEqual([]);
  });

  it('requires a quote for a file citation', async () => {
    const r = await checkCitations(ws, ['src/config.js:3 — reads PORT']);
    expect(r.invalid[0]?.reason).toBe(
      'no quote: add a short verbatim quote from src/config.js:3 in backticks',
    );
  });

  it('checks findings behind hypothesis or topic tags instead of letting them through', async () => {
    const r = await checkCitations(ws, [
      '[H2 against] src/config.js:3 — default is 8080 `process.env.PORT ?? 8080`',
      'F4 [H5 for, H1 against] [TOKENS] src/config.js:3 — `process.env.PORT ?? 3000`',
    ]);
    expect(r.checked).toBe(2);
    expect(r.valid).toHaveLength(1);
    expect(r.invalid[0]?.reason).toMatch(/is not at src\/config.js:3/);
  });

  it('matches markdown lines: emphasis, inline code and a quote that contains backticks', async () => {
    const r = await checkCitations(ws, [
      'README.md:3 — the studio port `Run npm start to open the studio on port 5173`',
      'README.md:3 — how to start it `Run `npm start` to open`',
      'README.md:3 — bold is kept or dropped `the **studio** on port`',
    ]);
    expect(r.invalid).toEqual([]);
  });

  it('accepts the quote at the cited line even when another backtick span comes first', async () => {
    const r = await checkCitations(ws, [
      'src/config.js:3 — `loadEnv` is not used; the port falls back to `process.env.PORT ?? 8080`',
    ]);
    expect(r.invalid).toEqual([]);
  });

  it('finds the citation however it is written, so dressing it up cannot skip the check', async () => {
    const invented = '`this line is invented`';
    const r = await checkCitations(ws, [
      `As shown in src/config.js:3 the default is 3000 ${invented}`,
      `**src/config.js:3** — default ${invented}`,
      `\`src/config.js\`:3 — default ${invented}`,
      `src/config.js line 3 — default ${invented}`,
      `src/config.js | line 3 — default ${invented}`,
      `[H2 against] src/config.js (line 3) — default ${invented}`,
    ]);
    expect(r.valid).toEqual([]);
    expect(r.checked).toBe(6);
    expect(r.invalid.every((x) => /is not at src\/config.js:3/.test(x.reason))).toBe(true);
    // The same forms with the real line pass.
    const ok = await checkCitations(ws, [
      'the default lives at **src/config.js:3** `port: Number(process.env.PORT ?? 8080)`',
      'src/config.js line 3 — `port: Number(process.env.PORT ?? 8080)`',
    ]);
    expect(ok.invalid).toEqual([]);
  });

  it('rejects quotes too short to prove anything, ranges as wide as the file, and claims that cite nothing', async () => {
    const r = await checkCitations(ws, [
      'src/config.js:3 — reads the port `port`',
      'README.md:1-200 — the studio runs on 5173 `open the studio`',
      'The engine probably validates answers before applying them',
    ]);
    expect(r.valid).toEqual([]);
    expect(r.invalid.map((x) => x.reason)).toEqual([
      expect.stringMatching(/^no quote/),
      expect.stringMatching(/spans 200 lines/),
      expect.stringMatching(/^cites nothing/),
    ]);
    // Other sources still pass: a URL, "source | location — fact", a commit, an issue.
    const other = await checkCitations(ws, [
      'https://nodejs.org/api/process.html — env values are strings',
      'experiment | npm test — 0 state changes (3 runs)',
      'commit 1a2b3c4d — added the default',
      'PR #42 — reviewers asked for the default',
    ]);
    expect(other.invalid).toEqual([]);
    expect(other.checked).toBe(0);
  });
});
