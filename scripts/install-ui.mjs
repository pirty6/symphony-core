// Installs the studio (packages/ui) after `npm install` at the root.
// npm workspaces merge both dependency trees and crash on their differing peer
// versions, so with npm the studio gets its own install, isolated like pnpm's.
// pnpm installs the workspace itself (pnpm-workspace.yaml), so this does nothing there.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('npm/')) process.exit(0);

const ui = fileURLToPath(new URL('../packages/ui/', import.meta.url));
if (!existsSync(ui)) process.exit(0);

const windows = process.platform === 'win32';
const result = spawnSync(
  windows ? 'npm.cmd' : 'npm',
  // Same peer handling as the root (.npmrc): see the note there.
  // The studio's lockfile pins exactly what CI tests; `ci` installs just that.
  [
    existsSync(join(ui, 'package-lock.json')) ? 'ci' : 'install',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
  ],
  { cwd: ui, stdio: 'inherit', shell: windows },
);
process.exit(result.status ?? 1);
