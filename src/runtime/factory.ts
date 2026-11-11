/** Shared provider construction for the CLI and the studio server. */
import type { MCPServerConfig } from '@github/copilot-sdk';
import type { Complexity, Pattern } from '../core/types.js';
import { defaultTools } from './builtin-tools.js';
import { discoverMcpServers } from './mcp.js';
import type { ToolContext, ToolRegistry } from './tools.js';
import { CopilotProvider, DEFAULT_TIERS, parseTiers, type Tier } from './copilot-provider.js';
import type { Provider } from './provider.js';
import { ScriptedProvider } from './scripted-provider.js';
import { signInsOff } from './signins.js';

/**
 * Who plays the AI steps: the offline demo's canned answers, GitHub Copilot (this machine's
 * sign-in), or your own model server (SYMPHONY_MODEL_URL).
 */
export type ProviderName = 'scripted' | 'copilot' | 'local';

export const PROVIDER_NAMES: readonly ProviderName[] = ['scripted', 'copilot', 'local'];

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
  readonly effortCaps?: boolean;
  /** Your own model server (SYMPHONY_MODEL_URL): what the 'local' provider plays on. */
  readonly localModel?: LocalModel;
  /** false: steps run with none of your credentials (SYMPHONY_SIGNINS=off). */
  readonly signIns?: boolean;
  /** Copilot as a studio visitor's own account (runtime/accounts.ts), never yours. */
  readonly copilotHome?: string;
}

export interface LocalModel {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model?: string;
  /** Copilot when the server does not answer (SYMPHONY_MODEL_FALLBACK=copilot; sign-ins allowed). */
  readonly fallback?: boolean;
}

export function isProviderName(v: unknown): v is ProviderName {
  return PROVIDER_NAMES.includes(v as ProviderName);
}

/** A real AI plays (not the offline demo): runs get worktrees, PR checkouts and sandboxes. */
export function playsLive(name: ProviderName): boolean {
  return name !== 'scripted';
}

/** The provider when none is chosen: your model server when one is set, else Copilot. */
export function defaultProvider(env: NodeJS.ProcessEnv): ProviderName {
  return localModelFrom(env) ? 'local' : 'copilot';
}

export const NO_LOCAL_MODEL =
  "provider 'local' needs your model server: set SYMPHONY_MODEL_URL (and SYMPHONY_MODEL_KEY, SYMPHONY_MODEL_ID) in .env, or choose 'copilot'";

const clock = (): string => new Date().toISOString();

export function makeProvider(cfg: ProviderConfig): Provider {
  if (cfg.provider === 'local' && !cfg.localModel) throw new Error(NO_LOCAL_MODEL);
  if (playsLive(cfg.provider)) {
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
      ...(cfg.effortCaps === false ? { effortCaps: false } : {}),
      // Copilot is always Copilot: the model server plays only when 'local' is chosen.
      ...(cfg.provider === 'local' && cfg.localModel ? { localModel: cfg.localModel } : {}),
      ...(cfg.signIns === false ? { signIns: false } : {}),
      ...(cfg.copilotHome ? { copilotHome: cfg.copilotHome } : {}),
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
  effortCaps?: boolean;
  localModel?: LocalModel;
  signIns?: boolean;
} {
  const model = env.COPILOT_MODEL ?? env.MODEL;
  const source = TOKEN_VARS.find((name) => env[name] && env[name] !== 'token');
  const token = source ? env[source] : undefined;
  const tiers = env.SYMPHONY_TIERS ? parseTiers(env.SYMPHONY_TIERS) : undefined;
  const nodeModels = env.SYMPHONY_NODE_MODELS
    ? parseNodeModels(env.SYMPHONY_NODE_MODELS)
    : undefined;
  const localModel = localModelFrom(env);
  return {
    ...(model ? { model } : {}),
    ...(token && source ? { gitHubToken: token, gitHubTokenSource: source } : {}),
    ...(localModel ? { localModel } : {}),
    ...(signInsOff(env) ? { signIns: false } : {}),
    ...(tiers ? { tiers } : {}),
    ...(env.SYMPHONY_ALT_MODEL ? { alternateModel: env.SYMPHONY_ALT_MODEL } : {}),
    ...(nodeModels ? { nodeModels } : {}),
    // On by default (they cut time and tokens); 0, false, off or no turns each off.
    deltaRepair: !off(env.SYMPHONY_DELTA_REPAIR),
    headerInSystem: !off(env.SYMPHONY_HEADER_IN_SYSTEM),
    // Trial 13: same solved, 45% fewer premium requests (a later revision is given up).
    endOnSubmit: !off(env.SYMPHONY_END_ON_SUBMIT),
    // Steps' maxEffort (the maestro's tier-4 debate on 'high'); 0 plays each tier's own effort.
    effortCaps: !off(env.SYMPHONY_EFFORT_CAPS),
  };
}

/**
 * SYMPHONY_MODEL_URL: an OpenAI-compatible server (vLLM, tt-inference-server, Ollama) for every
 * step, e.g. http://tt.example.org:8000/v1; SYMPHONY_MODEL_ID its model (default: the first it
 * lists), SYMPHONY_MODEL_KEY its API key if it needs one.
 */
export function localModelFrom(env: NodeJS.ProcessEnv): LocalModel | undefined {
  const baseUrl = env.SYMPHONY_MODEL_URL?.trim();
  if (!baseUrl) return undefined;
  const apiKey = env.SYMPHONY_MODEL_KEY?.trim();
  const model = env.SYMPHONY_MODEL_ID?.trim();
  const fallback = env.SYMPHONY_MODEL_FALLBACK?.trim().toLowerCase() === 'copilot';
  return {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

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
  // Without sign-ins: no MCP servers (they act as you), and no GitHub or Azure source.
  const noSignIns = signInsOff(env);
  const mcpOff = env.SYMPHONY_MCP === 'off' || noSignIns;
  const mcp = mcpOff
    ? { servers: {}, skipped: [] }
    : await discoverMcpServers({ workspace, includeUser, env });
  return {
    tools: defaultTools({
      mcp: { includeUser: mcpOff ? false : includeUser },
      ...(noSignIns ? { probeGitHub: false, probeAzure: false, noMcp: true } : {}),
    }),
    toolContext: { workspace, repoRoot },
    mcpServers: mcp.servers,
    mcpSkipped: mcp.skipped,
  };
}

/** The model per complexity tier that Copilot runs will use (defaults merged with SYMPHONY_TIERS). */
export function effectiveTiers(env: NodeJS.ProcessEnv): Record<Complexity, Tier> {
  return { ...DEFAULT_TIERS, ...(env.SYMPHONY_TIERS ? parseTiers(env.SYMPHONY_TIERS) : {}) };
}
