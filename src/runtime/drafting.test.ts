import { describe, expect, it } from 'vitest';
import type { AgentResponse, DraftRequest, Provider } from './provider.js';
import { draftPattern } from './drafting.js';
import { genericDraft } from '../core/draft.js';
import { ScriptedProvider } from './scripted-provider.js';

describe('draftPattern', () => {
  it('returns a valid pattern in one round with the scripted provider', async () => {
    const out = await draftPattern(new ScriptedProvider(), 'Add dark mode');
    expect(out.pattern?.name).toBe('add-dark-mode');
    expect(out.rounds).toHaveLength(1);
  });

  it('feeds validation errors back until the draft is valid', async () => {
    const seen: DraftRequest[] = [];
    const flaky: Provider = {
      name: 'flaky',
      runAgent: () => Promise.reject(new Error('n/a')),
      draft: async (req): Promise<AgentResponse> => {
        seen.push(req);
        const result = seen.length === 1 ? { name: 'x', nodes: [] } : genericDraft('second try');
        return { result, transcript: { provider: 'flaky', prompt: '', output: '', toolCalls: [] } };
      },
    };
    const out = await draftPattern(flaky, 'thing');
    expect(out.pattern).toBeDefined();
    expect(out.rounds.map((r) => r.errors.length > 0)).toEqual([true, false]);
    expect(seen[1]?.feedback?.join()).toMatch(/start node/);
    expect(seen[1]?.priorDraft).toEqual({ name: 'x', nodes: [] });
  });

  it('gives up after maxRounds', async () => {
    const bad: Provider = {
      name: 'bad',
      runAgent: () => Promise.reject(new Error('n/a')),
      draft: async () => ({
        result: 'nope',
        transcript: { provider: 'bad', prompt: '', output: '', toolCalls: [] },
      }),
    };
    const out = await draftPattern(bad, 'thing', { maxRounds: 2 });
    expect(out.pattern).toBeUndefined();
    expect(out.rounds).toHaveLength(2);
  });
});
