import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { replayPerformance } from '../core/replay.js';
import type { Pattern } from '../core/types.js';
import { performanceUsage } from '../core/usage.js';
import { Run } from './driver.js';
import type { AgentRequest, Provider } from './provider.js';

const reader: Pattern = {
  name: 'reader',
  description: 'reads files in parallel parts',
  requiredContext: ['files'],
  state: [
    { name: 'files', type: 'string[]' },
    { name: 'read', type: 'string[]' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'readAll',
      kind: 'agent',
      role: 'assessor',
      label: 'Read',
      directive: 'read every file',
      reads: ['files'],
      writes: ['read'],
      fanOut: { over: 'files', per: 2 },
      checks: [{ expr: 'subset(files, read)', message: 'Read every file.' }],
    },
    { id: 'end', kind: 'end', label: 'End', outcome: 'success' },
  ],
  edges: [
    { id: 'a', from: 'start', to: 'readAll' },
    { id: 'b', from: 'readAll', to: 'end' },
  ],
};

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const score = compileScore(reader, { goal: 'g', context: { files }, generatedAt: 't' });

/** Answers each part with its own files; later parts answer sooner. */
function slowFirst() {
  let inFlight = 0;
  let most = 0;
  const seen: string[][] = [];
  const provider: Provider = {
    name: 'fake',
    runAgent: async (req: AgentRequest) => {
      const mine = req.pause.input.files as string[];
      seen.push(mine);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 40 - files.indexOf(mine[0]!) * 5));
      inFlight -= 1;
      return {
        result: {
          updates: { read: mine },
          verdict: {
            outcome: 'applied',
            confidence: 1,
            shouldTerminate: false,
            reason: mine.join(''),
          },
        },
        transcript: {
          provider: 'fake',
          prompt: '',
          output: `read ${mine.join(',')}`,
          toolCalls: [],
          usage: {
            calls: 1,
            inputTokens: 100,
            outputTokens: 1,
            cacheReadTokens: 0,
            reasoningTokens: 0,
          },
        },
      };
    },
    draft: () => Promise.reject(new Error('n/a')),
  };
  return { provider, seen, most: () => most };
}

describe('fanOut parts play at the same time', () => {
  it('plays parts concurrently (bounded), merges in part order, and replays exactly', async () => {
    const fake = slowFirst();
    const perf = await new Run({ score, provider: fake.provider, parallel: 3 }).start();
    expect(perf.outcome).toBe('success');
    expect(fake.seen.map((s) => s.join(''))).toEqual(['ab', 'cd', 'ef', 'g']);
    expect(fake.most()).toBe(3);
    const step = perf.steps.find((s) => s.nodeId === 'readAll')!;
    expect(step.updates?.read).toEqual(files);
    expect(step.transcript?.parts?.map((t) => t.output)).toEqual([
      'read a,b',
      'read c,d',
      'read e,f',
      'read g',
    ]);
    expect(performanceUsage(perf).total.calls).toBe(4);
    expect(replayPerformance(score, perf).divergence.reproduced).toBe(true);
  });

  it('a part whose call fails is named, and the others are not lost', async () => {
    let calls = 0;
    const provider: Provider = {
      name: 'fake',
      runAgent: async (req) => {
        calls += 1;
        if (calls === 2) throw new Error('rate limited');
        const mine = req.pause.input.files as string[];
        return {
          result: {
            updates: { read: mine },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          },
          transcript: { provider: 'fake', prompt: '', output: '', toolCalls: [] },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const perf = await new Run({ score, provider, parallel: 1, autoApprove: true }).start();
    // The retry plays every part again and succeeds.
    expect(perf.outcome).toBe('success');
    const step = perf.steps.find((s) => s.nodeId === 'readAll')!;
    expect(step.attempts?.[0]?.errors[0]).toMatch(
      /^part 2 of 4: no result.*provider error: rate limited/,
    );
  });
});
