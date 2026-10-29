import { describe, expect, it } from 'vitest';
import { envConfig } from './factory.js';

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
});
