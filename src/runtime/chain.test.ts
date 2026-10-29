import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import type { ExecutableScore } from '../core/types.js';
import { investigate, PATTERNS } from '../patterns/index.js';
import { chainNext } from './chain.js';
import { Run } from './driver.js';
import { ScriptedProvider } from './scripted-provider.js';

const score = compileScore(investigate, { context: investigate.demo!.context!, generatedAt: 't' });

describe('chainNext', () => {
  it('after a successful run, starts the next pattern with what it found, passing on the rest', async () => {
    const started: { score: ExecutableScore; chain: readonly string[] }[] = [];
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
    await expect(next({} as never)).rejects.toThrow(/unknown pattern 'nope'/);
  });
});
