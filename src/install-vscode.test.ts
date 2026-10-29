import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SKILL_NAME,
  serverEntry,
  skillFromAgent,
  withServer,
  withoutServer,
} from './install-vscode.js';
import { stripJsonc } from './runtime/mcp.js';

const entry = serverEntry('/repo', '/usr/bin/node');
const parse = (t: string) => JSON.parse(stripJsonc(t)) as { servers: Record<string, unknown> };

describe('install:vscode', () => {
  it('runs the server with absolute node and tsx, whatever PATH VS Code has', () => {
    expect(entry).toEqual({
      type: 'stdio',
      command: '/usr/bin/node',
      args: [join('/repo', 'node_modules/tsx/dist/cli.mjs'), join('/repo', 'src/mcp-server.ts')],
    });
  });

  it('creates mcp.json, or adds to it keeping comments and other servers', () => {
    expect(parse(withServer(undefined, entry)).servers.symphony).toEqual(entry);
    const mine = `{
  // my servers
  "servers": {
    "teams": { "command": "agency", "args": ["mcp", "teams"] }, // keep me
  },
  "inputs": []
}`;
    const added = withServer(mine, entry);
    expect(added).toContain('// my servers');
    expect(added).toContain('// keep me');
    expect(Object.keys(parse(added).servers)).toEqual(['symphony', 'teams']);
    expect(parse(withServer('{ "servers": {} }', entry)).servers.symphony).toEqual(entry);
    expect(parse(withServer('{ "inputs": [] }', entry)).servers.symphony).toEqual(entry);
  });

  it('reinstalling replaces the entry; uninstalling removes only it', () => {
    const mine = '{\n  "servers": {\n    "teams": { "command": "agency" }\n  }\n}';
    const once = withServer(mine, entry);
    const moved = serverEntry('/other', '/usr/bin/node');
    const twice = withServer(once, moved);
    expect(parse(twice).servers.symphony).toEqual(moved);
    expect(twice.match(/"symphony"/g)).toHaveLength(1);
    const removed = withoutServer(twice);
    expect(Object.keys(parse(removed).servers)).toEqual(['teams']);
  });

  it("writes a maestrov2 skill for chats that load skills, with the agent's own instructions", () => {
    // Git may check it out with CRLF (Windows).
    const agent = readFileSync(
      join(import.meta.dirname, '../integrations/vscode/maestro-v2.agent.md'),
      'utf8',
    ).replaceAll('\r\n', '\n');
    const skill = skillFromAgent(agent);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!;
    expect(front).toMatch(new RegExp(`^name: ${SKILL_NAME}$`, 'm'));
    expect(SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/);
    const description = /^description: "(.*)"$/m.exec(front)![1]!;
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain('/maestrov2');
    // The relay rules come from the agent file, without its frontmatter (tools: is agent-only).
    expect(skill).toContain('NEVER answer an approval or a stuck step on the user');
    expect(skill).not.toMatch(/^tools:/m);
    expect(skill.match(/^---$/gm)).toHaveLength(2);
    expect(skillFromAgent(agent.replaceAll('\n', '\r\n'))).not.toMatch(/^tools:/m);
  });
});
