import { describe, expect, it } from 'vitest';
import { envConfig, parseNodeModels } from './factory.js';

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
    const defaults = { deltaRepair: true, headerInSystem: true };
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
    });
    expect(envConfig({ SYMPHONY_DELTA_REPAIR: '0', SYMPHONY_HEADER_IN_SYSTEM: 'off' })).toEqual({
      deltaRepair: false,
      headerInSystem: false,
    });
    expect(parseNodeModels('=x,y=')).toBeUndefined();
  });
});
