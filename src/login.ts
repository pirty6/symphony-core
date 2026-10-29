/**
 * npm run login: sign this machine's GitHub account in for Copilot, with the
 * Copilot CLI that ships inside the SDK (nothing else to install), then show
 * who Symphony will run as.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CopilotProvider } from './runtime/copilot-provider.js';
import { envConfig } from './runtime/factory.js';

/** The bundled Copilot CLI for this platform, found the way npm and pnpm lay it out. */
export function bundledCli(root = process.cwd()): string {
  const sdk = createRequire(join(root, 'package.json')).resolve('@github/copilot-sdk');
  const variants = process.platform === 'linux' ? ['linux', 'linuxmusl'] : [process.platform];
  for (let dir = dirname(sdk); dir !== dirname(dir); dir = dirname(dir)) {
    for (const v of variants) {
      const cli = join(dir, 'node_modules', '@github', `copilot-${v}-${process.arch}`, 'index.js');
      if (existsSync(cli)) return cli;
    }
  }
  throw new Error(
    `the Copilot CLI for ${process.platform}-${process.arch} is not installed: run npm install`,
  );
}

async function main(): Promise<number> {
  const signIn = spawnSync(process.execPath, [bundledCli(), 'login', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  if (signIn.status !== 0) return signIn.status ?? 1;
  const provider = new CopilotProvider(envConfig(process.env));
  try {
    const status = await provider.authStatus();
    console.log(
      status.signedIn
        ? `Signed in${status.login ? ` as ${status.login}` : ''}: Symphony can use Copilot now (AI: Copilot).`
        : status.message,
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
