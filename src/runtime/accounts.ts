/**
 * Studio visitors' own GitHub Copilot. A browser on another computer signs in with its own GitHub
 * account through the Copilot CLI's device flow (`copilot login`): GitHub shows the visitor a
 * code to enter on github.com, and the token goes from GitHub to this machine, never through the
 * visitor's browser or the network between them. Each visitor gets a Copilot home of its own
 * (COPILOT_HOME); its runs play as that account, never as the host's.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient } from '@github/copilot-sdk';
import { signInFreeEnv } from './signins.js';

/** A visitor's id (the studio's cookie): 32 random bytes in hex, never a path. */
export const ACCOUNT_ID = /^[a-f0-9]{64}$/;

export const newAccountId = (): string => randomBytes(32).toString('hex');

export interface DeviceCode {
  readonly url: string;
  readonly code: string;
}

export type AccountStatus =
  | { readonly signedIn: true; readonly login: string }
  | { readonly signedIn: false; readonly pending?: DeviceCode; readonly error?: string };

/**
 * The Copilot CLI the SDK itself starts (so sign-in and runs always use the same one).
 * Throws the SDK's own error when no compatible CLI is installed.
 */
export function bundledCli(): string {
  const client = new CopilotClient({ useLoggedInUser: true }) as unknown as {
    resolvedCliPath?: string;
  };
  if (!client.resolvedCliPath) throw new Error('the Copilot SDK did not report its CLI');
  return client.resolvedCliPath;
}

const DEVICE_CODE = /visit (https:\/\/\S+) and enter code ([A-Z0-9]{4}-[A-Z0-9]{4})/;
const CODE_WAIT_MS = 30_000;
/** GitHub's device codes expire after 15 minutes. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const KEYCHAIN_SERVICE = 'copilot-cli';
/**
 * Commands the CLI uses to open a browser or copy the code on the machine it runs on, replaced by
 * ones that do nothing: the visitor is not at this machine (and the host's browser is signed in
 * as the host).
 */
const QUIET_COMMANDS = ['noop', 'pbcopy', 'xclip', 'xsel', 'wl-copy'];

interface Pending {
  readonly child: ChildProcess;
  code?: DeviceCode;
  error?: string;
}

/** The login a Copilot home is signed in as, from its config (comment lines and all). */
export async function signedInLogin(copilotHome: string): Promise<string | undefined> {
  const text = await readFile(join(copilotHome, 'config.json'), 'utf8').catch(() => '');
  const json = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
  try {
    const login = (JSON.parse(json) as { lastLoggedInUser?: { login?: unknown } }).lastLoggedInUser
      ?.login;
    return typeof login === 'string' && login ? login : undefined;
  } catch {
    return undefined;
  }
}

export class VisitorAccounts {
  private readonly pending = new Map<string, Pending>();

  private readonly root: string;
  private readonly cli: () => string;
  /** The host's own Copilot home: its accounts are never signed out from here. */
  private readonly hostHome: string;

  constructor(
    root: string,
    cli: () => string = bundledCli,
    hostHome: string = process.env.COPILOT_HOME || join(homedir(), '.copilot'),
  ) {
    this.root = root;
    this.cli = cli;
    this.hostHome = hostHome;
  }

  /** A visitor's Copilot home: their sign-in and nothing else of this machine's. */
  home(id: string): string {
    if (!ACCOUNT_ID.test(id)) throw new Error('invalid account id');
    return join(this.root, id);
  }

  async status(id: string): Promise<AccountStatus> {
    const login = await signedInLogin(this.home(id));
    if (login) return { signedIn: true, login };
    const p = this.pending.get(id);
    return {
      signedIn: false,
      ...(p?.code && p.child.exitCode === null ? { pending: p.code } : {}),
      ...(p?.error ? { error: p.error } : {}),
    };
  }

  /** Start the device flow; the code the visitor enters at GitHub from their own browser. */
  async login(id: string): Promise<DeviceCode> {
    const running = this.pending.get(id);
    if (running?.code && running.child.exitCode === null) return running.code;
    const home = this.home(id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const quiet = await this.quietCommands();
    const cli = this.cli();
    const [command, args] = cli.endsWith('.js')
      ? [process.execPath, [cli, 'login']]
      : [cli, ['login']];
    const child = spawn(command, args, {
      env: {
        ...signInFreeEnv(process.env),
        COPILOT_HOME: home,
        BROWSER: join(quiet, 'noop'),
        PATH: `${quiet}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pending: Pending = { child };
    this.pending.set(id, pending);
    const timeout = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
    timeout.unref?.();
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + String(d)).slice(-2000)));
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) pending.error = stderr.trim().split('\n').at(-1) || `sign-in ended (${code})`;
    });
    return new Promise<DeviceCode>((resolve, reject) => {
      let out = '';
      const fail = (why: string) => {
        child.kill();
        reject(new Error(why));
      };
      const wait = setTimeout(
        () => fail('GitHub did not give a sign-in code in time'),
        CODE_WAIT_MS,
      );
      child.stdout?.on('data', (d: Buffer) => {
        out += String(d);
        const m = DEVICE_CODE.exec(out);
        if (!m) return;
        clearTimeout(wait);
        pending.code = { url: m[1]!, code: m[2]! };
        resolve(pending.code);
      });
      child.on('exit', () => {
        clearTimeout(wait);
        if (!pending.code)
          reject(new Error(pending.error ?? 'sign-in ended before GitHub gave a code'));
      });
    });
  }

  /**
   * Sign a visitor out: stop a sign-in in progress, remove their token from the keychain (unless
   * the host itself is signed in as that account) and their Copilot home.
   */
  async logout(id: string): Promise<void> {
    const home = this.home(id);
    this.pending.get(id)?.child.kill();
    this.pending.delete(id);
    const login = await signedInLogin(home);
    if (login && login !== (await signedInLogin(this.hostHome)))
      await forgetKeychainToken(`https://github.com:${login}`);
    await rm(home, { recursive: true, force: true });
  }

  private async quietCommands(): Promise<string> {
    const dir = join(this.root, '.quiet');
    await mkdir(dir, { recursive: true });
    for (const name of QUIET_COMMANDS) {
      const file = join(dir, name);
      await writeFile(file, '#!/bin/sh\ncat >/dev/null 2>&1 || true\n');
      await chmod(file, 0o755);
    }
    return dir;
  }
}

/** macOS keeps the CLI's tokens in the login keychain, one entry per host and login. */
function forgetKeychainToken(account: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise((resolve) => {
    const p = spawn(
      'security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
      {
        stdio: 'ignore',
      },
    );
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}
