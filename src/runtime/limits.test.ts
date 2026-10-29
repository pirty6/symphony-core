import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STEP_TIMEOUT_MS, stepTimeLimitMs } from './limits.js';

describe('step time limit', () => {
  const saved = process.env.SYMPHONY_STEP_TIMEOUT_S;
  afterEach(() => {
    if (saved === undefined) delete process.env.SYMPHONY_STEP_TIMEOUT_S;
    else process.env.SYMPHONY_STEP_TIMEOUT_S = saved;
  });

  it('is 15 minutes unless SYMPHONY_STEP_TIMEOUT_S says otherwise', () => {
    delete process.env.SYMPHONY_STEP_TIMEOUT_S;
    expect(stepTimeLimitMs()).toBe(DEFAULT_STEP_TIMEOUT_MS);
    process.env.SYMPHONY_STEP_TIMEOUT_S = '90';
    expect(stepTimeLimitMs()).toBe(90_000);
    process.env.SYMPHONY_STEP_TIMEOUT_S = 'nonsense';
    expect(stepTimeLimitMs()).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });
});
