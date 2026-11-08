import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signInFreeEnv, signInsOff } from './signins.js';

const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

describe('sign-ins off: nothing a step runs acts as the host', () => {
  it('is off only when asked', () => {
    expect(signInsOff({})).toBe(false);
    expect(signInsOff({ SYMPHONY_SIGNINS: 'off' })).toBe(true);
    expect(signInsOff({ SYMPHONY_SIGNINS: '0' })).toBe(true);
    expect(signInsOff({ SYMPHONY_SIGNINS: 'on' })).toBe(false);
  });

  it('drops credential variables and keeps the rest', () => {
    const env = signInFreeEnv(
      { PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', SSH_AUTH_SOCK: '/s', HOME: '/h' },
      '/tmp/empty',
    );
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/h');
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) expect(env[k]).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBe('/tmp/empty/gh');
    expect(env.AZURE_CONFIG_DIR).toBe('/tmp/empty/azure');
  });

  it('git has no credential helper, after any it already had', () => {
    const env = signInFreeEnv(
      {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'osxkeychain',
      },
      mkdtempSync(join(tmpdir(), 'signins-')),
    );
    const helpers = execFileSync('git', ['config', '--get-all', 'credential.helper'], {
      env,
      encoding: 'utf8',
    }).split('\n');
    // An empty helper resets the list: none before it is used.
    expect(helpers.at(-2)).toBe('');
    expect(helpers).toContain('osxkeychain');
  });

  it.runIf(has('gh'))('gh is signed in as nobody', () => {
    const env = signInFreeEnv(process.env, mkdtempSync(join(tmpdir(), 'signins-')));
    const r = spawnSync('gh', ['auth', 'status'], { env, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });
});
