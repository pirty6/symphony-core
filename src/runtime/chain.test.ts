import { describe, expect, it } from 'vitest';
import type { ChainStep } from '../core/chain.js';
import { compileScore } from '../core/compile.js';
import type { ExecutableScore } from '../core/types.js';
import { backlog, investigate, PATTERNS } from '../patterns/index.js';
import { chainNext } from './chain.js';
import { Run } from './driver.js';
import { ScriptedProvider } from './scripted-provider.js';

const score = compileScore(investigate, { context: investigate.demo!.context!, generatedAt: 't' });

describe('chainNext', () => {
  it('after a successful run, starts the next pattern with what it found, passing on the rest', async () => {
    const started: { score: ExecutableScore; chain: readonly ChainStep[] }[] = [];
    const run = new Run({
      score,
      provider: ScriptedProvider.forPattern(investigate),
      demo: investigate.demo,
      autoApprove: true,
      clock: () => 't',
      next: chainNext({
        chain: ['fix', 'refactor'],
        score,
        library: async () => PATTERNS,
        inputs: { fix: { testCommand: 'npm test' } },
        start: async (s, _p, chain) => {
          started.push({ score: s, chain });
          return 'run-2';
        },
      }),
    });
    await run.start();
    expect(started).toHaveLength(1);
    expect(started[0]!.score.pattern).toBe('fix');
    expect(started[0]!.chain).toEqual(['refactor']);
    expect(String(started[0]!.score.context.issue)).toContain('What the investigate run found');
    expect(started[0]!.score.context.testCommand).toBe('npm test');
    expect(run.messages.find((m) => m.type === 'next')).toMatchObject({ runId: 'run-2' });
  });

  it('does nothing without a chain, and refuses unknown patterns', async () => {
    expect(
      chainNext({ chain: [], score, library: async () => PATTERNS, start: async () => '' }),
    ).toBeUndefined();
    const next = chainNext({
      chain: ['nope'],
      score,
      library: async () => PATTERNS,
      start: async () => '',
    })!;
    await expect(next({ outcome: 'success', finalState: {} } as never)).rejects.toThrow(
      /unknown pattern 'nope'/,
    );
  });
});

const item = (goal: string): ChainStep => ({
  pattern: 'implement',
  goal,
  context: { testCommand: 'npm test' },
});
const end = (outcome: string, finalState = {}) => ({ outcome, finalState }) as never;
const hook = (chain: readonly ChainStep[], from: ExecutableScore = score) => {
  const started: { score: ExecutableScore; chain: readonly ChainStep[] }[] = [];
  const next = chainNext({
    chain,
    score: from,
    library: async () => PATTERNS,
    start: async (s, _p, rest) => {
      started.push({ score: s, chain: rest });
      return 'child';
    },
  });
  return { next, started };
};

describe('chainNext with backlog items', () => {
  it('a successful backlog run starts its first item with the others queued behind it', async () => {
    const b = compileScore(backlog, { context: { source: 'doc.md' }, generatedAt: 't' });
    const { next, started } = hook(['review'], b);
    await next!(
      end('success', {
        runPattern: 'implement',
        queue: ['add a flag', 'show requests'],
        testCommand: 'npm test',
      }),
    );
    expect(started[0]!.score.pattern).toBe('implement');
    expect(started[0]!.score.goal).toBe('add a flag');
    expect(started[0]!.score.context).toMatchObject({
      request: 'add a flag',
      testCommand: 'npm test',
    });
    expect(started[0]!.chain).toEqual([item('show requests'), 'review']);
  });

  it('an item plays after a failed or partial item, with its own request (not the last result)', async () => {
    for (const outcome of ['failed', 'partial']) {
      const { next, started } = hook([item('second')]);
      await next!(end(outcome));
      expect(started[0]!.score.context.request).toBe('second');
    }
  });

  it('a chained pattern does not play after a failure, and stopping a run stops every item', async () => {
    const plain = hook(['fix']);
    expect(await plain.next!(end('failed'))).toBeUndefined();
    const items = hook([item('second')]);
    expect(await items.next!(end('cancelled'))).toBeUndefined();
    expect([...plain.started, ...items.started]).toEqual([]);
  });
});
