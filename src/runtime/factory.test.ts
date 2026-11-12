import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER,
  envConfig,
  isProviderName,
  makeProvider,
  parseNodeModels,
  runtimeExtras,
} from './factory.js';

describe('envConfig', () => {
  it('takes the most specific token variable and says which one it was', () => {
    expect(envConfig({ TOKEN: 'a', GITHUB_TOKEN: 'b' })).toMatchObject({
      gitHubToken: 'b',
      gitHubTokenSource: 'GITHUB_TOKEN',
    });
    expect(envConfig({ COPILOT_GITHUB_TOKEN: 'c', GH_TOKEN: 'd' })).toMatchObject({
      gitHubTokenSource: 'COPILOT_GITHUB_TOKEN',
    });
  });

  it('no token, or the template placeholder: use the signed-in account', () => {
    const defaults = {
      deltaRepair: true,
      headerInSystem: true,
      endOnSubmit: true,
      effortCaps: true,
    };
    expect(envConfig({})).toEqual(defaults);
    expect(envConfig({ TOKEN: 'token' })).toEqual(defaults);
    expect(envConfig({ TOKEN: '' })).toEqual(defaults);
  });

  it('reads the switches: a model per step; delta repair and the header in the system message (on unless turned off)', () => {
    expect(
      envConfig({
        SYMPHONY_NODE_MODELS: 'deepRead=claude-opus-5.5, triage = gpt-6-luna,bad',
        SYMPHONY_DELTA_REPAIR: '1',
        SYMPHONY_HEADER_IN_SYSTEM: 'true',
      }),
    ).toEqual({
      nodeModels: { deepRead: 'claude-opus-5.5', triage: 'gpt-6-luna' },
      deltaRepair: true,
      headerInSystem: true,
      endOnSubmit: true,
      effortCaps: true,
    });
    expect(
      envConfig({
        SYMPHONY_DELTA_REPAIR: '0',
        SYMPHONY_HEADER_IN_SYSTEM: 'off',
        SYMPHONY_END_ON_SUBMIT: 'no',
        SYMPHONY_EFFORT_CAPS: 'false',
      }),
    ).toEqual({
      deltaRepair: false,
      headerInSystem: false,
      endOnSubmit: false,
      effortCaps: false,
    });
    expect(parseNodeModels('=x,y=')).toBeUndefined();
  });
});

describe('a local model, and no sign-ins', () => {
  it('reads the model server from the environment', () => {
    expect(envConfig({}).localModel).toBeUndefined();
    expect(envConfig({ SYMPHONY_MODEL_URL: 'http://tt:8000/v1' }).localModel).toEqual({
      baseUrl: 'http://tt:8000/v1',
    });
    expect(
      envConfig({
        SYMPHONY_MODEL_URL: 'http://tt:8000/v1',
        SYMPHONY_MODEL_ID: 'openai/gpt-oss-120b',
        SYMPHONY_MODEL_KEY: 'k',
      }).localModel,
    ).toEqual({ baseUrl: 'http://tt:8000/v1', model: 'openai/gpt-oss-120b', apiKey: 'k' });
    expect(envConfig({ SYMPHONY_SIGNINS: 'off' }).signIns).toBe(false);
    expect(envConfig({}).signIns).toBeUndefined();
  });

  it('you choose per run: copilot is always Copilot, local is your model server', () => {
    const env = { SYMPHONY_MODEL_URL: 'http://tt:8000/v1', SYMPHONY_MODEL_ID: 'q' };
    const served = (provider: 'copilot' | 'local') =>
      (
        makeProvider({ provider, ...envConfig(env) }) as unknown as {
          opts: { localModel?: unknown };
        }
      ).opts.localModel;
    expect(served('local')).toEqual({ baseUrl: 'http://tt:8000/v1', model: 'q' });
    expect(served('copilot')).toBeUndefined();
    // Recorded as such: a resumed run plays on the same one, and answers replay only on it.
    expect(makeProvider({ provider: 'local', ...envConfig(env) }).name).toBe('local');
    expect(makeProvider({ provider: 'copilot', ...envConfig(env) }).name).toBe('copilot');
    expect(() => makeProvider({ provider: 'local' })).toThrow(/SYMPHONY_MODEL_URL/);
    // Unchosen: Copilot, even with a model server set.
    expect(DEFAULT_PROVIDER).toBe('copilot');
    expect(['scripted', 'copilot', 'local'].every(isProviderName)).toBe(true);
    expect(isProviderName('gpt')).toBe(false);
  });

  it('without sign-ins: no MCP servers, and no GitHub or Azure source', async () => {
    // A workspace that configures an MCP server of its own.
    const ws = mkdtempSync(join(tmpdir(), 'signins-ws-'));
    mkdirSync(join(ws, '.vscode'));
    writeFileSync(
      join(ws, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: { teams: { type: 'stdio', command: 'node', args: ['x.js'] } } }),
    );
    const env = { ...process.env, SYMPHONY_MCP_USER: 'off' };
    const names = async (e: NodeJS.ProcessEnv) => {
      const x = await runtimeExtras(ws, ws, e);
      const out = (await x.tools.get('sources.catalog')!.run({}, {
        workspace: ws,
        repoRoot: ws,
        signal: new AbortController().signal,
      } as never)) as { names: string[] };
      return { names: out.names, servers: Object.keys(x.mcpServers) };
    };
    // With sign-ins, the workspace's server is a source; without, it is not.
    expect((await names(env)).names).toContain('mcp:teams');
    const extras = await runtimeExtras(ws, ws, { ...env, SYMPHONY_SIGNINS: 'off' });
    expect(extras.mcpServers).toEqual({});
    const catalog = extras.tools.get('sources.catalog')!;
    const out = (await catalog.run({}, {
      workspace: ws,
      repoRoot: ws,
      signal: new AbortController().signal,
    } as never)) as { names: string[] };
    expect(out.names).not.toContain('github');
    expect(out.names).not.toContain('azure');
    expect(out.names.some((n) => n.startsWith('mcp:'))).toBe(false);
  });
});
