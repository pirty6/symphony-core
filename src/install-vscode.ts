/**
 * Install Symphony into VS Code for this user, for every workspace:
 *   - the /maestrov2 prompt and the maestro-v2 agent (user prompts folder), for Copilot Chat
 *   - the maestrov2 skill (~/.agents/skills), for chats that load skills instead of
 *     prompt files (Copilot CLI and the VS Code agent host)
 *   - the 'symphony' MCP server (user mcp.json); VS Code starts it on demand,
 *     so there is nothing to keep running
 *
 *   npm run install:vscode            (add -- --insiders for VS Code Insiders)
 *   npm run install:vscode -- --uninstall
 *
 * Existing mcp.json comments and servers are kept: the entry is inserted as text.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workPatternNames } from './patterns/index.js';
import { SYMPHONY_SERVER_NAME, stripJsonc, userMcpFiles } from './runtime/mcp.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = ['maestrov2.prompt.md', 'maestro-v2.agent.md'];

export const SKILL_NAME = 'maestrov2';

/**
 * The maestrov2 skill: the maestro-v2 agent's instructions under a skill header,
 * so both entry points relay the same way (one source, no drift).
 */
export function skillFromAgent(agent: string): string {
  const body = agent
    .replaceAll('\r\n', '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .trim();
  return `---
name: ${SKILL_NAME}
description: "Run the Symphony maestro: a deterministic, auditable pipeline (${workPatternNames().join(', ')}) through the symphony MCP server, relaying every approval and stuck step to the user. Use when: /maestrov2, maestrov2, maestro, run the maestro, Symphony, deterministic investigation, fix or feature implementation."
argument-hint: "What do you want done? e.g. find out why login fails on CI, then fix it"
---

# Symphony maestro (/maestrov2)

Run the Symphony maestro on the user's request, in this workspace, with the symphony MCP server's tools (maestro, run_pattern, get_run, answer_approval, answer_stuck, stop_run, list_patterns). If the user gave no request, ask what they want done before starting. If those tools are not available, tell the user to run \`npm run install:vscode\` in their symphony-core checkout and reload the window.

${body}
`;
}

/** The server entry: absolute node + tsx, so it works whatever PATH VS Code has. */
export function serverEntry(repoRoot: string, node = process.execPath) {
  return {
    type: 'stdio',
    command: node,
    args: [
      join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(repoRoot, 'src', 'mcp-server.ts'),
    ],
  };
}

/** Add (or replace) the symphony server in mcp.json text, keeping everything else as written. */
export function withServer(text: string | undefined, entry: object): string {
  const json = JSON.stringify(entry);
  if (!text?.trim())
    return `${JSON.stringify({ servers: { [SYMPHONY_SERVER_NAME]: entry } }, null, 2)}\n`;
  const parsed = JSON.parse(stripJsonc(text)) as { servers?: Record<string, unknown> };
  const line = `"${SYMPHONY_SERVER_NAME}": ${json}`;
  if (parsed.servers?.[SYMPHONY_SERVER_NAME]) {
    const without = withoutServer(text);
    return withServer(without, entry);
  }
  const servers = /"servers"\s*:\s*\{/.exec(text);
  if (servers) {
    const at = servers.index + servers[0].length;
    const empty = Object.keys(parsed.servers ?? {}).length === 0;
    return `${text.slice(0, at)}\n    ${line}${empty ? '' : ','}${text.slice(at)}`;
  }
  const open = text.indexOf('{');
  const rest = text.slice(open + 1).trim();
  return `${text.slice(0, open + 1)}\n  "servers": {\n    ${line}\n  }${rest.startsWith('}') ? '' : ','}${text.slice(open + 1)}`;
}

/** Remove the symphony server line written by withServer. */
export function withoutServer(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith(`"${SYMPHONY_SERVER_NAME}":`))
    .join('\n')
    .replace(/,(\s*})/g, '$1');
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const files = userMcpFiles(homedir(), platform(), process.env);
  const mcpFile = args.has('--insiders') ? files[1]! : files[0]!;
  const user = dirname(mcpFile);
  const prompts = join(user, 'prompts');
  const current = existsSync(mcpFile) ? readFileSync(mcpFile, 'utf8') : undefined;
  const skill = join(homedir(), '.agents', 'skills', SKILL_NAME);

  if (args.has('--uninstall')) {
    for (const f of FILES) rmSync(join(prompts, f), { force: true });
    rmSync(skill, { recursive: true, force: true });
    if (current) writeFileSync(mcpFile, withoutServer(current));
    console.log(
      `Removed /maestrov2, the maestro-v2 agent and the symphony server from ${user}, and the ${SKILL_NAME} skill`,
    );
    return;
  }

  if (!existsSync(join(repo, 'node_modules', 'tsx'))) {
    console.error('Run npm install first (the server runs with tsx from this checkout).');
    process.exit(1);
  }
  mkdirSync(prompts, { recursive: true });
  for (const f of FILES) copyFileSync(join(repo, 'integrations', 'vscode', f), join(prompts, f));
  mkdirSync(skill, { recursive: true });
  const agent = readFileSync(join(repo, 'integrations', 'vscode', 'maestro-v2.agent.md'), 'utf8');
  writeFileSync(join(skill, 'SKILL.md'), skillFromAgent(agent));
  if (current) writeFileSync(`${mcpFile}.bak`, current);
  writeFileSync(mcpFile, withServer(current, serverEntry(repo)));
  console.log(`Installed for every workspace:
  /maestrov2 and the maestro-v2 agent   ${prompts}
  maestrov2 skill (CLI / agent host)   ${skill}
  symphony MCP server                  ${mcpFile}${current ? ` (backup: ${mcpFile}.bak)` : ''}

In VS Code: reload the window, open Chat and type /maestrov2 <what you want done>.
VS Code starts the server when the agent needs it; the AI runs on your signed-in Copilot account.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
