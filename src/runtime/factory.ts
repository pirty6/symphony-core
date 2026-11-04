/** Shared provider construction for the CLI and the studio server. */
import type { MCPServerConfig } from '@github/copilot-sdk';
import type { Complexity, Pattern } from '../core/types.js';
import { defaultTools } from './builtin-tools.js';
import { discoverMcpServers } from './mcp.js';
import type { ToolContext, ToolRegistry } from './tools.js';
import { CopilotProvider, DEFAULT_TIERS, parseTiers, type Tier } from './copilot-provider.js';
import type { Provider } from './provider.js';
import { ScriptedProvider } from './scripted-provider.js';

export type ProviderName = 'scripted' | 'copilot';

export interface ProviderConfig {
  readonly provider: ProviderName;
  readonly pattern?: Pattern;
  readonly model?: string;
  readonly gitHubToken?: string;
  readonly gitHubTokenSource?: string;
  readonly workingDirectory?: string;
  /** Streaming delay for the scripted provider (ms). */
  readonly delayMs?: number;
  readonly mcpServers?: Readonly<Record<string, MCPServerConfig>>;
  readonly tiers?: Partial<Record<Complexity, Tier>>;
  readonly alternateModel?: string;
  /** Trials: one step on another model, delta repair, the step's header in the system message. */
  readonly nodeModels?: Readonly<Record<string, string>>;
  readonly deltaRepair?: boolean;
  readonly headerInSystem?: boolean;
  readonly endOnSubmit?: boolean;
}

export function isProviderName(v: unknown): v is ProviderName {
  return v === 'scripted' || v === 'copilot';
}

const clock = (): string => new Date().toISOString();

export function makeProvider(cfg: ProviderConfig): Provider {
  if (cfg.provider === 'copilot') {
    return new CopilotProvider({
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.gitHubToken ? { gitHubToken: cfg.gitHubToken } : {}),
      ...(cfg.gitHubTokenSource ? { gitHubTokenSource: cfg.gitHubTokenSource } : {}),
      ...(cfg.workingDirectory ? { workingDirectory: cfg.workingDirectory } : {}),
      ...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
      ...(cfg.tiers ? { tiers: cfg.tiers } : {}),
      ...(cfg.alternateModel ? { alternateModel: cfg.alternateModel } : {}),
      ...(cfg.nodeModels ? { nodeModels: cfg.nodeModels } : {}),
      ...(cfg.deltaRepair ? { deltaRepair: true } : {}),
      ...(cfg.headerInSystem ? { headerInSystem: true } : {}),
      ...(cfg.endOnSubmit ? { endOnSubmit: true } : {}),
      clock,
    });
  }
  return new ScriptedProvider({
    ...(cfg.pattern?.demo ? { demo: cfg.pattern.demo } : {}),
    delayMs: cfg.delayMs ?? 0,
    clock,
  });
}

/** Env vars: COPILOT_MODEL / MODEL, GITHUB_TOKEN / TOKEN (optional: the SDK also uses your logged-in user). */
/** Where a GitHub token for Copilot may be set, most specific first. */
export const TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'TOKEN'] as const;

export function envConfig(env: NodeJS.ProcessEnv): {
  model?: string;
  gitHubToken?: string;
  gitHubTokenSource?: string;
  tiers?: Partial<Record<Complexity, Tier>>;
  alternateModel?: string;
  nodeModels?: Record<string, string>;
  deltaRepair?: boolean;
  headerInSystem?: boolean;
  endOnSubmit?: boolean;
} {
  const model = env.COPILOT_MODEL ?? env.MODEL;
  const source = TOKEN_VARS.find((name) => env[name] && env[name] !== 'token');
  const token = source ? env[source] : undefined;
  const tiers = env.SYMPHONY_TIERS ? parseTiers(env.SYMPHONY_TIERS) : undefined;
  const nodeModels = env.SYMPHONY_NODE_MODELS
    ? parseNodeModels(env.SYMPHONY_NODE_MODELS)
    : undefined;
  return {
    ...(model ? { model } : {}),
    ...(token && source ? { gitHubToken: token, gitHubTokenSource: source } : {}),
    ...(tiers ? { tiers } : {}),
    ...(env.SYMPHONY_ALT_MODEL ? { alternateModel: env.SYMPHONY_ALT_MODEL } : {}),
    ...(nodeModels ? { nodeModels } : {}),
    // On by default (they cut time and tokens); 0, false, off or no turns each off.
    deltaRepair: !off(env.SYMPHONY_DELTA_REPAIR),
    headerInSystem: !off(env.SYMPHONY_HEADER_IN_SYSTEM),
    // Off until a trial shows it keeps quality: a revision after the answer would be lost.
    ...(on(env.SYMPHONY_END_ON_SUBMIT) ? { endOnSubmit: true } : {}),
  };
}

const on = (v: string | undefined) => v !== undefined && /^(1|true|on|yes)$/i.test(v.trim());

const off = (v: string | undefined) => v !== undefined && /^(0|false|off|no)$/i.test(v.trim());

/** "deepRead=claude-opus-4.5,skeptic=claude-opus-5.5:high": a model (and effort) per step id. */
export function parseNodeModels(text: string): Record<string, string> | undefined {
  const pairs = text
    .split(',')
    .map((p) => p.split('=').map((x) => x.trim()))
    .filter((p): p is [string, string] => p.length === 2 && p[0] !== '' && p[1] !== '');
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

export interface RuntimeExtras {
  readonly tools: ToolRegistry;
  readonly toolContext: Omit<ToolContext, 'signal'>;
  readonly mcpServers: Readonly<Record<string, MCPServerConfig>>;
  /** MCP servers found but unusable, with the reason. */
  readonly mcpSkipped: readonly string[];
}

/**
 * Tools for `tool` nodes and MCP servers for agents.
 * SYMPHONY_MCP=off disables MCP; SYMPHONY_MCP_USER=off ignores the VS Code user mcp.json.
 */
export async function runtimeExtras(
  workspace: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeExtras> {
  const includeUser = env.SYMPHONY_MCP_USER !== 'off';
  const mcp =
    env.SYMPHONY_MCP === 'off'
      ? { servers: {}, skipped: [] }
      : await discoverMcpServers({ workspace, includeUser, env });
  return {
    tools: defaultTools(
      env.SYMPHONY_MCP === 'off' ? { mcp: { includeUser: false } } : { mcp: { includeUser } },
    ),
    toolContext: { workspace, repoRoot },
    mcpServers: mcp.servers,
    mcpSkipped: mcp.skipped,
  };
}

/** The model per complexity tier that Copilot runs will use (defaults merged with SYMPHONY_TIERS). */
export function effectiveTiers(env: NodeJS.ProcessEnv): Record<Complexity, Tier> {
  return { ...DEFAULT_TIERS, ...(env.SYMPHONY_TIERS ? parseTiers(env.SYMPHONY_TIERS) : {}) };
}
