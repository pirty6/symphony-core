/**
 * npm run login: sign this machine's GitHub account in for Copilot, with the
 * Copilot CLI that ships inside the SDK (nothing else to install), then show
 * who Symphony will run as.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { CopilotProvider } from './runtime/copilot-provider.js';
import { envConfig } from './runtime/factory.js';

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

async function main(): Promise<number> {
  const cli = bundledCli();
  // Older CLIs ship a Node entry point (index.js), newer ones a native binary.
  const [command, args] = cli.endsWith('.js')
    ? [process.execPath, [cli, 'login', ...process.argv.slice(2)]]
    : [cli, ['login', ...process.argv.slice(2)]];
  const signIn = spawnSync(command, args, { stdio: 'inherit' });
  if (signIn.status !== 0) return signIn.status ?? 1;
  const provider = new CopilotProvider(envConfig(process.env));
  try {
    const status = await provider.authStatus();
    console.log(
      status.signedIn
        ? `Signed in${status.login ? ` as ${status.login}` : ''}${status.message ? ` (${status.message})` : ''}: Symphony can use Copilot now (AI: Copilot).`
        : status.message,
    );
    // A token variable is used before this sign-in: an old or classic one makes every request fail.
    if (status.tokenSource)
      console.log(
        `Note: ${status.tokenSource} is set (in .env or your environment) and is used before this sign-in. If runs fail with "Authorization error", remove it; Symphony then uses the account you just signed in with.`,
      );
    return status.signedIn ? 0 : 1;
  } finally {
    await provider.dispose?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
