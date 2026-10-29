/**
 * The one time limit for an AI step: SYMPHONY_STEP_TIMEOUT_S (seconds), default
 * 15 minutes. The driver enforces it; providers only keep a later safety net.
 * Read without Node's types: the studio type-checks the driver for the browser.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60_000;

export function stepTimeLimitMs(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const seconds = Number(env?.SYMPHONY_STEP_TIMEOUT_S);
  return seconds > 0 ? seconds * 1000 : DEFAULT_STEP_TIMEOUT_MS;
}
