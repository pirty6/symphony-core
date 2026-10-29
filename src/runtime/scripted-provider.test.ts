import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { createEngine } from '../core/engine.js';
import { parseDraft } from '../core/draft.js';
import type { AgentPause } from '../core/types.js';
import { hangman, review } from '../patterns/index.js';
import type { ProviderEvent } from './provider.js';
import { genericDraft } from '../core/draft.js';
import { ScriptedProvider } from './scripted-provider.js';

function firstPause(p = hangman, context = {}) {
  const score = compileScore(p, { goal: 'g', context });
  const r = createEngine(score);
  return { pause: r.state.pause as AgentPause, state: r.state.state };
}

describe('ScriptedProvider', () => {
  it('answers from the demo script and streams output', async () => {
    const { pause, state } = firstPause();
    const events: ProviderEvent[] = [];
    const provider = ScriptedProvider.forPattern(hangman);
    const res = await provider.runAgent({
      pause,
      state,
      visit: 0,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    expect(res.result).toMatchObject({ updates: { word: 'planet' } });
    expect(events.filter((e) => e.type === 'delta').length).toBeGreaterThan(1);
    expect(events.some((e) => e.type === 'tool-start' && e.name === 'submit_result')).toBe(true);
    expect(res.transcript.prompt).toContain('Pick word');
  });

  it('falls back to schema-valid placeholders', async () => {
    const { pause, state } = firstPause(review, { target: 'x' });
    const res = await new ScriptedProvider().runAgent({
      pause,
      state,
      visit: 0,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(res.result).toMatchObject({
      updates: { diffSummary: '' },
      verdict: { outcome: 'applied' },
    });
  });

  it('can be aborted mid-stream', async () => {
    const { pause, state } = firstPause();
    const ctrl = new AbortController();
    const provider = ScriptedProvider.forPattern(hangman, { delayMs: 20 });
    const run = provider.runAgent({
      pause,
      state,
      visit: 0,
      signal: ctrl.signal,
      onEvent: () => ctrl.abort(),
    });
    await expect(run).rejects.toThrow(/aborted/);
  });

  it('drafts a valid pattern', async () => {
    const res = await new ScriptedProvider().draft({
      request: 'Upgrade the logging library',
      instructions: '',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const parsed = parseDraft(res.result);
    expect(parsed.ok).toBe(true);
    expect(parseDraft(genericDraft('!!!')).ok).toBe(true);
  });
});
