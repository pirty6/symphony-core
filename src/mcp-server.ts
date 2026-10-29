/**
 * Symphony MCP server entry.
 *
 *   tsx src/mcp-server.ts            stdio (VS Code starts it on demand)
 *   tsx src/mcp-server.ts --http     Streamable HTTP for Copilot Studio
 *       --port 8787 --host 127.0.0.1; needs SYMPHONY_MCP_KEY; patterns that
 *       edit files only with SYMPHONY_ALLOW_EDITS=1
 *
 * Env: SYMPHONY_WORKSPACE (folder to work in; default: the client's workspace
 * root over stdio, the current folder over HTTP).
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mcpHttpHandler } from './mcp/http.js';
import { RunManager } from './mcp/runs.js';
import { clientWorkspace, createSymphonyServer } from './mcp/server.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(repoRoot, '.env'), quiet: true });

const { values } = parseArgs({
  options: {
    http: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT ?? '8787' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

if (values.http) {
  const apiKey = process.env.SYMPHONY_MCP_KEY ?? '';
  if (apiKey.length < 16) {
    console.error(
      'Set SYMPHONY_MCP_KEY (16+ characters) to serve MCP over HTTP, e.g.\n  export SYMPHONY_MCP_KEY=$(openssl rand -hex 24)',
    );
    process.exit(1);
  }
  const editsAllowed = process.env.SYMPHONY_ALLOW_EDITS === '1';
  const workspace = process.env.SYMPHONY_WORKSPACE ?? process.cwd();
  const runs = new RunManager({
    workspace: async () => workspace,
    repoRoot,
    env: process.env,
    editsAllowed,
  });
  const handle = mcpHttpHandler({ runs, apiKey });
  const port = Number(values.port);
  createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }).listen(port, values.host, () => {
    console.error(
      `Symphony MCP on http://${values.host}:${port}/mcp · workspace ${workspace} · ${editsAllowed ? 'edits ALLOWED' : 'read-only patterns (SYMPHONY_ALLOW_EDITS=1 to allow edits)'}`,
    );
  });
} else {
  // stdout carries the protocol: anything else logged must go to stderr.
  console.log = console.error;
  console.info = console.error;
  let server: ReturnType<typeof createSymphonyServer> | undefined;
  const runs = new RunManager({
    workspace: () => clientWorkspace(server!, process.env),
    repoRoot,
    env: process.env,
    editsAllowed: true,
  });
  server = createSymphonyServer(runs);
  await server.connect(new StdioServerTransport());
}
