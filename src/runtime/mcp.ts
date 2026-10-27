/**
 * MCP server discovery: VS Code user `mcp.json` plus the workspace's
 * `.vscode/mcp.json` and `.mcp.json` (workspace wins on name collisions).
 */
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { MCPServerConfig } from '@github/copilot-sdk';

export interface McpDiscovery {
  readonly servers: Readonly<Record<string, MCPServerConfig>>;
  /** Servers found but not usable, with the reason. */
  readonly skipped: readonly string[];
  readonly files: readonly string[];
}

export interface McpOptions {
  readonly workspace: string;
  /** Include the VS Code user-level mcp.json. Default true. */
  readonly includeUser?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
}

export function userMcpFiles(home: string, os: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const editions = ['Code', 'Code - Insiders'];
  const base =
    os === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : os === 'win32'
        ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return editions.map((e) => join(base, e, 'User', 'mcp.json'));
}

/** Remove // and /* comments and trailing commas outside of strings. */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

type Resolved = { ok: true; value: string } | { ok: false; reason: string };

function substitute(
  value: string,
  workspace: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Resolved {
  let reason: string | undefined;
  const result = value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name === 'workspaceFolder') return workspace;
    if (name === 'userHome') return home;
    if (name.startsWith('env:')) {
      const v = env[name.slice(4)];
      if (v === undefined) reason ??= `environment variable ${name.slice(4)} is not set`;
      return v ?? '';
    }
    if (name.startsWith('input:')) reason ??= `needs the VS Code input '${name.slice(6)}'`;
    else reason ??= `unsupported variable ${whole}`;
    return '';
  });
  return reason ? { ok: false, reason } : { ok: true, value: result };
}

function convert(
  raw: Record<string, unknown>,
  workspace: string,
  home: string,
  env: NodeJS.ProcessEnv,
): { ok: true; value: MCPServerConfig } | { ok: false; reason: string } {
  if (raw.disabled === true) return { ok: false, reason: 'disabled' };
  const failures: string[] = [];
  const sub = (v: unknown): string => {
    const r = substitute(String(v), workspace, home, env);
    if (!r.ok) failures.push(r.reason);
    return r.ok ? r.value : '';
  };
  const subRecord = (v: unknown): Record<string, string> | undefined =>
    v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, sub(x)]),
        )
      : undefined;
  const type = typeof raw.type === 'string' ? raw.type : raw.url ? 'http' : 'stdio';
  let value: MCPServerConfig;
  if (type === 'http' || type === 'sse') {
    if (typeof raw.url !== 'string') return { ok: false, reason: 'http server without url' };
    const headers = subRecord(raw.headers);
    value = { type, url: sub(raw.url), tools: ['*'], ...(headers ? { headers } : {}) };
  } else {
    if (typeof raw.command !== 'string')
      return { ok: false, reason: 'stdio server without command' };
    const envVars = subRecord(raw.env);
    const args = Array.isArray(raw.args) ? raw.args.map(sub) : [];
    value = {
      type: 'stdio',
      command: sub(raw.command),
      args,
      tools: ['*'],
      ...(envVars ? { env: envVars } : {}),
      ...(typeof raw.cwd === 'string' ? { workingDirectory: sub(raw.cwd) } : {}),
    };
  }
  return failures.length > 0 ? { ok: false, reason: failures[0]! } : { ok: true, value };
}

async function readServers(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const json = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
  const servers = (json.servers ?? json.mcpServers) as Record<string, unknown> | undefined;
  return servers && typeof servers === 'object' ? servers : {};
}

export async function discoverMcpServers(opts: McpOptions): Promise<McpDiscovery> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const files = [
    ...(opts.includeUser === false ? [] : userMcpFiles(home, opts.platform ?? platform(), env)),
    join(opts.workspace, '.vscode', 'mcp.json'),
    join(opts.workspace, '.mcp.json'),
  ];
  const servers: Record<string, MCPServerConfig> = {};
  const skipped: string[] = [];
  const found: string[] = [];
  for (const file of files) {
    let entries: Record<string, unknown> | undefined;
    try {
      entries = await readServers(file);
    } catch (e) {
      skipped.push(`${file}: unreadable (${(e as Error).message})`);
      continue;
    }
    if (!entries) continue;
    found.push(file);
    for (const [name, raw] of Object.entries(entries)) {
      const converted =
        raw && typeof raw === 'object'
          ? convert(raw as Record<string, unknown>, opts.workspace, home, env)
          : ({ ok: false, reason: 'not an object' } as const);
      if (converted.ok) servers[name] = converted.value;
      else skipped.push(`${name}: ${converted.reason}`);
    }
  }
  return { servers, skipped, files: found };
}
