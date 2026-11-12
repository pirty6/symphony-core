import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { newAccountId, signedInLogin, VisitorAccounts } from './accounts.js';

const tmp = mkdtempSync(join(tmpdir(), 'symphony-accounts-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Stands in for `copilot login`: shows a device code, then (once "authorized") records the login
 * in its Copilot home, and notes what it was started with.
 */
function fakeCli(login: string, delayMs = 50): string {
  const file = join(tmp, `cli-${login}.js`);
  writeFileSync(
    file,
    `const fs = require('fs'), path = require('path');
const home = process.env.COPILOT_HOME;
fs.writeFileSync(path.join(home, 'env.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.stdout.write('To authenticate, visit https://github.com/login/device and enter code ABCD-1234.\\nWaiting for authorization...\\n');
setTimeout(() => {
  fs.writeFileSync(path.join(home, 'config.json'), '// managed\\n{ "lastLoggedInUser": { "host": "https://github.com", "login": ${JSON.stringify(login)} } }');
  process.exit(0);
}, ${delayMs});
`,
  );
  return file;
}

describe('visitor accounts', () => {
  it('a visitor signs in with the device flow into a Copilot home of its own', async () => {
    vi.stubEnv('GH_TOKEN', 'host-token');
    const accounts = new VisitorAccounts(
      join(tmp, 'a'),
      () => fakeCli('octocat'),
      join(tmp, 'host'),
    );
    const id = newAccountId();
    expect(await accounts.status(id)).toEqual({ signedIn: false });
    expect(await accounts.login(id)).toEqual({
      url: 'https://github.com/login/device',
      code: 'ABCD-1234',
    });
    await expect.poll(() => accounts.status(id)).toEqual({ signedIn: true, login: 'octocat' });
    const seen = JSON.parse(readFileSync(join(accounts.home(id), 'env.json'), 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(seen.argv).toEqual(['login']);
    expect(seen.env.COPILOT_HOME).toBe(accounts.home(id));
    // Nothing opens a browser or copies the code on this machine; none of the host's tokens.
    expect(seen.env.BROWSER).toMatch(/[.]quiet[/\\]noop$/);
    expect(seen.env.PATH!.split(':')[0]).toMatch(/[.]quiet$/);
    expect(seen.env.GH_TOKEN).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('ids are never paths; signing out removes the visitor home', async () => {
    const accounts = new VisitorAccounts(
      join(tmp, 'b'),
      () => fakeCli('hubot', 0),
      join(tmp, 'host'),
    );
    expect(() => accounts.home('../../etc')).toThrow(/invalid account id/);
    const id = newAccountId();
    await accounts.login(id);
    await expect.poll(() => accounts.status(id)).toMatchObject({ signedIn: true });
    await accounts.logout(id);
    expect(existsSync(accounts.home(id))).toBe(false);
    expect(await accounts.status(id)).toEqual({ signedIn: false });
  });

  it('reads the signed-in login from a CLI config with comment lines', async () => {
    const home = join(tmp, 'cfg');
    mkdirSync(home, { recursive: true });
    expect(await signedInLogin(home)).toBeUndefined();
    writeFileSync(join(home, 'config.json'), '// note\n{ "lastLoggedInUser": { "login": "me" } }');
    expect(await signedInLogin(home)).toBe('me');
  });
});
