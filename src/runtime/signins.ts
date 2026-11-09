/**
 * Runs that must not act as the person hosting Symphony (a studio shared on a network, a local
 * model): SYMPHONY_SIGNINS=off. Whatever command a step runs, its environment holds no
 * credential: no GitHub or Copilot token, empty gh and az configuration, no git credential helper
 * and no SSH agent.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** Variables that carry a credential, or point at where one is kept. */
const CREDENTIAL_VARS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'TOKEN',
  'SSH_AUTH_SOCK',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_DEVOPS_EXT_PAT',
  'SYSTEM_ACCESSTOKEN',
] as const;

export function signInsOff(env: Env): boolean {
  const v = env.SYMPHONY_SIGNINS?.trim();
  return v !== undefined && /^(0|false|off|no)$/i.test(v);
}

/**
 * SYMPHONY_SIGNINS=here: your sign-ins only for runs started on this computer (a browser on
 * localhost, the CLI, a VS Code chat); runs from other machines get none. The environment for a
 * run started here (`here`) or from elsewhere.
 */
export function envForRun(env: Env, here: boolean): Env {
  const v = env.SYMPHONY_SIGNINS?.trim().toLowerCase();
  return v === 'here' && !here ? { ...env, SYMPHONY_SIGNINS: 'off' } : env;
}

/** Whether a request comes from this computer (its loopback address). */
export function fromThisComputer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const a = remoteAddress.replace(/^::ffff:/, '');
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.');
}

let empty: string | undefined;
/** One empty folder per process: where gh and az look for a sign-in, and find none. */
function emptyConfigDir(): string {
  empty ??= mkdtempSync(join(tmpdir(), 'symphony-no-signins-'));
  return empty;
}

/** The environment without any credential the host has, for processes AI steps may drive. */
export function signInFreeEnv(env: Env, dir: string = emptyConfigDir()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && !(CREDENTIAL_VARS as readonly string[]).includes(k)) out[k] = v;
  // Git settings from the environment come after every config file: no credential helper (the
  // keychain), no prompt, and SSH with no key or agent.
  const base = Number(out.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    ...out,
    GH_CONFIG_DIR: join(dir, 'gh'),
    AZURE_CONFIG_DIR: join(dir, 'azure'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND:
      'ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes',
    GIT_CONFIG_COUNT: String(base + 1),
    [`GIT_CONFIG_KEY_${base}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${base}`]: '',
  };
}
