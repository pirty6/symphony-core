import { describe, expect, it } from 'vitest';
import { serverEntry, withServer, withoutServer } from './install-vscode.js';
import { stripJsonc } from './runtime/mcp.js';

const entry = serverEntry('/repo', '/usr/bin/node');
const parse = (t: string) => JSON.parse(stripJsonc(t)) as { servers: Record<string, unknown> };

describe('install:vscode', () => {
  it('runs the server with absolute node and tsx, whatever PATH VS Code has', () => {
    expect(entry).toEqual({
      type: 'stdio',
      command: '/usr/bin/node',
      args: ['/repo/node_modules/tsx/dist/cli.mjs', '/repo/src/mcp-server.ts'],
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
});
