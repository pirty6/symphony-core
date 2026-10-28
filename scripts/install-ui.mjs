// Installs the studio (packages/ui) after `npm install` at the root.
// npm workspaces merge both dependency trees and crash on their differing peer
// versions, so with npm the studio gets its own install, isolated like pnpm's.
// pnpm installs the workspace itself (pnpm-workspace.yaml), so this does nothing there.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('npm/')) process.exit(0);

const ui = fileURLToPath(new URL('../packages/ui/', import.meta.url));
if (!existsSync(ui)) process.exit(0);

const windows = process.platform === 'win32';
const result = spawnSync(windows ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
  cwd: ui,
  stdio: 'inherit',
  shell: windows,
});
process.exit(result.status ?? 1);
