import { describe, expect, it } from 'vitest';
import { envConfig, parseNodeModels } from './factory.js';

describe('envConfig', () => {
  it('takes the most specific token variable and says which one it was', () => {
    expect(envConfig({ TOKEN: 'a', GITHUB_TOKEN: 'b' })).toEqual({
      gitHubToken: 'b',
      gitHubTokenSource: 'GITHUB_TOKEN',
    });
    expect(envConfig({ COPILOT_GITHUB_TOKEN: 'c', GH_TOKEN: 'd' })).toMatchObject({
      gitHubTokenSource: 'COPILOT_GITHUB_TOKEN',
    });
  });

  it('no token, or the template placeholder: use the signed-in account', () => {
    expect(envConfig({})).toEqual({});
    expect(envConfig({ TOKEN: 'token' })).toEqual({});
    expect(envConfig({ TOKEN: '' })).toEqual({});
  });

  it('reads the trial switches: a model per step, delta repair, the header in the system message', () => {
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
    });
    expect(envConfig({ SYMPHONY_DELTA_REPAIR: '0', SYMPHONY_HEADER_IN_SYSTEM: 'off' })).toEqual({});
    expect(parseNodeModels('=x,y=')).toBeUndefined();
  });
});
