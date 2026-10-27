import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseContext } from './cli.js';
import { fix, hangman } from './patterns/index.js';

const cwd = mkdtempSync(join(tmpdir(), 'symphony-cli-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

let out = '';
// oxlint-disable-next-line no-control-regex
const plain = () => out.replace(/\x1b\[[0-9;]*m/g, '');
beforeEach(() => {
  out = '';
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out += `${a.join(' ')}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    out += `${a.join(' ')}\n`;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
});

describe('parseContext', () => {
  it('coerces by field type', () => {
    expect(parseContext(['maxWrong=3', 'guessed=a,b', 'won=true', 'word=hi'], hangman)).toEqual({
      maxWrong: 3,
      guessed: ['a', 'b'],
      won: true,
      word: 'hi',
    });
    expect(parseContext(['files=["a.ts"]'], fix)).toEqual({ files: ['a.ts'] });
  });

  it('rejects unknown keys and bad pairs', () => {
    expect(() => parseContext(['nope=1'], hangman)).toThrow(/not a state field/);
    expect(() => parseContext(['=1'], hangman)).toThrow(/key=value/);
  });
});

describe('main', () => {
  it('lists patterns', async () => {
    expect(await main(['list'], cwd)).toBe(0);
    expect(out).toMatch(/hangman/);
    expect(out).toMatch(/needs: issue/);
  });

  it('runs a pattern end to end, saves it and verifies the replay', async () => {
    expect(await main(['run', 'fix', '--auto-approve'], cwd)).toBe(0);
    expect(out).toMatch(/✔ success/);
    const saved = /saved (\S+\.json)/.exec(out)?.[1];
    expect(saved).toBeDefined();
    out = '';
    expect(await main(['verify', saved!], cwd)).toBe(0);
    expect(out).toMatch(/reproduced exactly/);
    out = '';
    expect(await main(['runs'], cwd)).toBe(0);
    expect(out).toMatch(/fix\s+success/);
  });

  it('reports compile errors for missing context', async () => {
    expect(await main(['run', 'review', '-c', 'target=', '--no-save'], cwd)).toBe(1);
    expect(out).toMatch(/missing required context 'target'/);
  });

  it('drafts and saves a TypeScript pattern that is then listed', async () => {
    expect(await main(['draft', 'Rename the config loader', '--save'], cwd)).toBe(0);
    expect(out).toMatch(/valid draft/);
    out = '';
    await main(['list'], cwd);
    expect(out).toMatch(/rename-the-config-loader/);
  });

  it('maestro composes a score and performs it', async () => {
    expect(
      await main(['maestro', 'Fix the flaky login test', '--auto-approve', '--no-save'], cwd),
    ).toBe(0);
    expect(plain()).toMatch(/maestro score .* 🎻 Classical/);
    expect(out).toMatch(/composed 'fix'/);
    expect(plain()).toMatch(/fix score .* complexity 3/);
    expect(out).toMatch(/reached end 'fixed'/);
  });

  it('maestro --compose-only stops after composing', async () => {
    expect(
      await main(
        ['maestro', 'Fix the flaky login test', '--auto-approve', '--no-save', '--compose-only'],
        cwd,
      ),
    ).toBe(0);
    expect(plain()).toMatch(/♪ composed 'fix' complexity 3/);
    expect(plain()).not.toMatch(/performing the composed score/);
  });

  it('accepts complexity and improvisation by name', async () => {
    expect(
      await main(
        ['run', 'analyze', '-i', 'bebop', '--complexity', '4', '--auto-approve', '--no-save'],
        cwd,
      ),
    ).toBe(0);
    expect(plain()).toMatch(/complexity 4 · 🎺 Bebop/);
    await expect(main(['run', 'analyze', '-i', 'polka', '--no-save'], cwd)).rejects.toThrow(
      /--improvisation/,
    );
  });
});
