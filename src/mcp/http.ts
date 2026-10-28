/**
 * Streamable HTTP for remote MCP clients (Copilot Studio). Stateless: each
 * request gets a fresh MCP server over the shared RunManager, so runs outlive
 * requests. Every MCP request needs the API key (x-api-key, or a Bearer token).
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RunManager } from './runs.js';
import { createSymphonyServer } from './server.js';

const MAX_BODY = 1024 * 1024;

function keyMatches(given: string | undefined, key: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The key a request presents: x-api-key, or Authorization: Bearer <key>. */
export function presentedKey(req: IncomingMessage): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export function mcpHttpHandler(opts: { readonly runs: RunManager; readonly apiKey: string }) {
  if (opts.apiKey.length < 16) throw new Error('the API key must be at least 16 characters');
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health') return send(res, 200, { ok: true, server: 'symphony' });
    if (path !== '/mcp') return send(res, 404, { error: 'not found' });
    if (!keyMatches(presentedKey(req), opts.apiKey)) {
      return send(res, 401, { error: 'missing or wrong API key (x-api-key header)' });
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone event stream, no sessions to delete.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
    const server = createSymphonyServer(opts.runs);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
