import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledCli } from './login.js';

describe('npm run login', () => {
  it('finds the Copilot CLI that ships with the SDK, for this platform', () => {
    const cli = bundledCli();
    expect(existsSync(cli)).toBe(true);
    expect(cli).toMatch(new RegExp(`copilot-[a-z]+-${process.arch}[\\\\/]index\\.js$`));
  });
});
