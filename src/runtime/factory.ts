/** Shared provider construction for the CLI and the studio server. */
import type { Pattern } from '../core/types.js';
import { CopilotProvider } from './copilot-provider.js';
import type { Provider } from './provider.js';
import { ScriptedProvider } from './scripted-provider.js';

export type ProviderName = 'scripted' | 'copilot';

export interface ProviderConfig {
  readonly provider: ProviderName;
  readonly pattern?: Pattern;
  readonly model?: string;
  readonly gitHubToken?: string;
  readonly workingDirectory?: string;
  /** Streaming delay for the scripted provider (ms). */
  readonly delayMs?: number;
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
      ...(cfg.workingDirectory ? { workingDirectory: cfg.workingDirectory } : {}),
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
export function envConfig(env: NodeJS.ProcessEnv): { model?: string; gitHubToken?: string } {
  const model = env.COPILOT_MODEL ?? env.MODEL;
  const token = env.GITHUB_TOKEN ?? env.TOKEN;
  return {
    ...(model ? { model } : {}),
    ...(token && token !== 'token' ? { gitHubToken: token } : {}),
  };
}
