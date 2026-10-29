import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkCitations } from './evidence.js';

const ws = mkdtempSync(join(tmpdir(), 'symphony-evidence-'));
afterAll(() => rmSync(ws, { recursive: true, force: true }));
mkdirSync(join(ws, 'src'));
writeFileSync(
  join(ws, 'src', 'config.js'),
  ['// config', 'export const config = {', '  port: Number(process.env.PORT ?? 8080),', '};'].join(
    '\n',
  ),
);

describe('checkCitations', () => {
  it('keeps real citations, with or without a quote, and passes other sources through', async () => {
    const r = await checkCitations(ws, [
      'src/config.js:3 — the default port is 8080 `port: Number(process.env.PORT ?? 8080)`',
      'F7 src/config.js:2-3 — config is a plain object',
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
});
