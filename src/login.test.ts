import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledCli } from './login.js';

describe('npm run login', () => {
  // A fresh npm install once paired the SDK with a CLI it could not start; this catches it.
  it('finds the Copilot CLI the SDK starts, for this platform', () => {
    const cli = bundledCli();
    expect(existsSync(cli)).toBe(true);
    expect(cli).toMatch(/copilot-(darwin|linux|linuxmusl|win32)-(x64|arm64)/);
  });
});
