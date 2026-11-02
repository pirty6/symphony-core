import { describe, expect, it } from 'vitest';
import type { AiTranscript, PerformedStep, TokenUsage } from './types.js';
import {
  costliest,
  firstCallCache,
  growthRatios,
  wallTimeByNode,
  formatUsage,
  performanceUsage,
  growth,
  rateLimits,
  recordSize,
  rejectionReasons,
  rejectionUsage,
  stepShares,
  transcriptUsage,
} from './usage.js';

const u = (input: number, output: number, calls = 1) => ({
  calls,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  reasoningTokens: 0,
});
const t = (usage: TokenUsage = u(100, 10), extra: Partial<AiTranscript> = {}): AiTranscript => ({
  provider: 'copilot',
  prompt: '',
  output: '',
  toolCalls: [],
  usage,
  ...extra,
});
const step = (nodeId: string, extra: Partial<PerformedStep>): PerformedStep =>
  ({
    step: 1,
    nodeId,
    kind: 'agent',
    moveKey: 'm',
    stateHashBefore: 'a',
    stateHashAfter: 'b',
    changes: [],
    ...extra,
  }) as PerformedStep;

const call = (updates: unknown) => ({ name: 'submit_result', args: { updates }, ok: true });

describe('token usage', () => {
  it('counts every answer: rejected attempts and jazz takes too', () => {
    const steps = [
      step('plan', { transcript: t(), attempts: [{ errors: ['x'], transcript: t(u(50, 5)) }] }),
      step('answer', { transcript: t(u(200, 20), { takes: [t(u(300, 30)), t(u(300, 30))] }) }),
      step('route', { kind: 'compute' }),
    ];
    const { total, byNode } = performanceUsage({ steps });
    expect(total).toEqual(u(950, 95, 5));
    expect(byNode.plan).toEqual(u(150, 15, 2));
    expect(Object.keys(byNode)).toEqual(['plan', 'answer']);
  });

  it('per visit, and which steps grow visit by visit', () => {
    const steps = [
      step('assess', { transcript: t(u(40_000, 10)) }),
      step('chase', { transcript: t(u(90_000, 10)) }),
      step('assess', { transcript: t(u(120_000, 10)) }),
      step('assess', { transcript: t(u(210_000, 10)) }),
      step('chase', { transcript: t(u(80_000, 10)) }),
    ];
    const { byVisit } = performanceUsage({ steps });
    expect(byVisit.map((v) => [v.nodeId, v.usage.inputTokens])).toEqual([
      ['assess', 40_000],
      ['chase', 90_000],
      ['assess', 120_000],
      ['assess', 210_000],
      ['chase', 80_000],
    ]);
    // chase shrank: only assess grows.
    expect(growth(byVisit)).toEqual(['assess: 40k → 120k → 210k in']);
  });

  it('answers replayed from the repertoire cost nothing this run', () => {
    expect(transcriptUsage(t(u(500, 50), { fromRepertoire: 'r.json' }))).toEqual(u(0, 0, 0));
    expect(transcriptUsage(undefined).calls).toBe(0);
  });

  it('separates what rejected answers cost, and counts answers that sent updates as text', () => {
    const steps = [
      step('skeptic', {
        transcript: t(u(100, 10), { toolCalls: [call({ failureModes: [] })] }),
        attempts: [
          {
            errors: ['updates arrived as text'],
            transcript: t(
              { ...u(400, 40), premiumRequests: 2 },
              { toolCalls: [call('{"failureModes":["f"]')] },
            ),
          },
        ],
      }),
      step('plan', {
        transcript: t(u(50, 5), {
          toolCalls: [call('{"subQuestions":["q"]'), call({ subQuestions: ['q'] })],
        }),
      }),
    ];
    const r = rejectionUsage({ steps });
    expect(r.attempts).toBe(1);
    expect(r.attemptUsage).toMatchObject({ inputTokens: 400, premiumRequests: 2, calls: 1 });
    expect(r.textUpdates).toBe(2);
    expect(rejectionUsage({ steps: [step('a', { transcript: t() })] })).toMatchObject({
      attempts: 0,
      textUpdates: 0,
    });
  });

  it('counts rejections by step and reason, values folded so the same check counts once', () => {
    const steps = [
      step('assess', {
        attempts: [
          { errors: ['Give exactly one assessment entry per sub-question (got 3, want 4)'] },
          { errors: ['Give exactly one assessment entry per sub-question (got 2, want 4)'] },
        ],
      }),
      step('deepRead', {
        attempts: [{ errors: ['newFindings: "src/a.ts:9 — x" — no such line', 'other'] }],
      }),
    ];
    expect(rejectionReasons({ steps })).toEqual({
      'assess: Give exactly one assessment entry per sub-question (got N, want N)': 2,
      'deepRead: newFindings: "…" — no such line': 1,
      'deepRead: other': 1,
    });
  });

  it('counts rate limits: failed model calls (parts too) and items unreadable for one', () => {
    const limited = t(u(0, 0), { output: 'provider error: HTTP 429 Too Many Requests' });
    const steps = [
      step('deepRead', {
        transcript: t(u(1, 1), { parts: [limited, t()] }),
        attempts: [
          {
            errors: ['x'],
            transcript: t(u(0, 0), { output: 'provider error: rate limit exceeded' }),
          },
        ],
        updates: { unreadableReasons: ['HTTP 429 twice', 'binary file'] },
      }),
      step('chase', { transcript: t(u(1, 1), { output: 'it said 429 lines' }) }),
      // Sessions that waited a rate limit out and started again count too.
      step('answer', {
        transcript: t(u(1, 1), { musician: { tier: 2, sampling: 's', rateLimitWaits: 2 } }),
      }),
    ];
    expect(rateLimits({ steps })).toEqual({ provider: 4, reads: 1 });
  });

  it('measures the saved run, and what the read notes and preload records add', () => {
    const preloaded = [{ path: 'a.ts', lines: 3 }];
    const perf = {
      steps: [
        step('deepRead', {
          transcript: t(u(1, 1), { preloaded }),
          updates: { readNotes: ['a.ts — x'] },
        }),
      ],
    } as unknown as Parameters<typeof recordSize>[0];
    const size = recordSize(perf);
    expect(size.readNotes).toBe(JSON.stringify(['a.ts — x']).length);
    expect(size.preloaded).toBe(JSON.stringify(preloaded).length);
    expect(size.run).toBe(JSON.stringify(perf).length);
  });

  it('ranks the costliest steps by premium requests, then input tokens', () => {
    const top = costliest(
      {
        classify: u(5000, 100),
        propose: { ...u(90_000, 9000), premiumRequests: 3 },
        skeptic: { ...u(20_000, 900), premiumRequests: 1 },
        context: u(8000, 50),
      },
      3,
    );
    expect(top.map((x) => x.node)).toEqual(['propose', 'skeptic', 'context']);
    expect(top[0]!.text).toMatch(
      /^75% of the cost: 90k in · 9k out · 1 calls · 3 premium requests$/,
    );
    expect(top.map((x) => x.share)).toEqual([75, 25, 0]);
    const timed = costliest({ a: { ...u(10, 1), apiMs: 3000 }, b: { ...u(30, 1), apiMs: 1000 } });
    expect(timed.map((x) => [x.node, x.share, x.timeShare])).toEqual([
      ['b', 75, 25],
      ['a', 25, 75],
    ]);
    expect(timed[1]!.text).toMatch(/^25% of the cost, 75% of model time: /);
  });

  it('reads well', () => {
    expect(formatUsage({ ...u(1_234_000, 45_000, 37), cacheReadTokens: 800_000 })).toBe(
      '1.2M in (800k cached) · 45k out · 37 calls',
    );
    expect(formatUsage(u(0, 0, 0))).toBe('no AI tokens');
  });
});

/** A transcript that ran from :from to :to seconds past the minute. */
const timed = (from: string, to: string) => ({
  provider: 'p',
  prompt: '',
  output: '',
  toolCalls: [],
  startedAt: `2026-01-01T00:00:${from}Z`,
  completedAt: `2026-01-01T00:00:${to}Z`,
});

describe('time and growth per step', () => {
  it('wall time adds every answer of a step, rejected ones too; growth is last visit over first', () => {
    const steps = [
      {
        nodeId: 'read',
        transcript: timed('00', '10'),
        attempts: [{ errors: [], transcript: timed('10', '12') }],
      },
      { nodeId: 'read', transcript: timed('20', '25') },
      { nodeId: 'end' },
    ] as never;
    expect(wallTimeByNode({ steps })).toEqual({ read: 17_000 });
    expect(
      growthRatios([
        { nodeId: 'assess', step: 1, usage: u(100, 0) },
        { nodeId: 'assess', step: 5, usage: u(250, 0) },
        { nodeId: 'answer', step: 6, usage: u(900, 0) },
      ]),
    ).toEqual({ assess: 2.5 });
  });

  it('a fan-out recorded without its own clock is timed from its first part to its last', () => {
    // Older runs: the parent transcript had no times, only its parts did.
    const parts = [
      timed('00', '30'),
      timed('05', '40'),
      { provider: 'p', prompt: '', output: '', toolCalls: [] },
    ];
    const steps = [
      {
        nodeId: 'chase',
        transcript: { provider: 'p', prompt: '', output: '', toolCalls: [], parts },
      },
      // With its own clock, that is used (parts kept from an earlier attempt are not re-timed).
      { nodeId: 'deepRead', transcript: { ...timed('00', '05'), parts: [timed('00', '50')] } },
    ] as never;
    expect(wallTimeByNode({ steps })).toEqual({ chase: 40_000, deepRead: 5_000 });
  });

  it("each step's share of the run, parts and rejected answers counted", () => {
    const steps = [
      {
        nodeId: 'chase',
        transcript: { ...t(u(0, 0)), parts: [{ ...timed('00', '30'), usage: u(300, 1) }] },
      },
      {
        nodeId: 'answer',
        transcript: { ...timed('30', '40'), usage: u(50, 1) },
        attempts: [{ errors: ['x'], transcript: { ...timed('40', '50'), usage: u(50, 1) } }],
      },
    ] as never;
    const rows = stepShares({ steps });
    expect(rows.map((r) => [r.node, r.usage.inputTokens, r.inputShare, r.ms, r.timeShare])).toEqual(
      [
        ['chase', 300, 0.75, 30_000, 0.6],
        ['answer', 100, 0.25, 20_000, 0.4],
      ],
    );
  });
});

/** A session whose first call read `first` tokens, `cached` of them from the cache. */
const session = (first: number, cached: number) => ({
  provider: 'p',
  prompt: '',
  output: '',
  toolCalls: [],
  calls: [
    { inputTokens: first, outputTokens: 1, cacheReadTokens: cached },
    { inputTokens: 999, outputTokens: 1, cacheReadTokens: 999 },
  ],
});

describe('first-call cache', () => {
  it("adds each session's first call per step, every part on its own", () => {
    const steps = [
      {
        nodeId: 'parts',
        transcript: { ...session(0, 0), parts: [session(100, 0), session(100, 90)] },
      },
      {
        nodeId: 'one',
        transcript: session(50, 10),
        attempts: [{ errors: [], transcript: session(50, 0) }],
      },
      { nodeId: 'old', transcript: { provider: 'p', prompt: '', output: '', toolCalls: [] } },
    ] as never;
    expect(firstCallCache({ steps })).toEqual({
      parts: { sessions: 2, inputTokens: 200, cacheReadTokens: 90 },
      one: { sessions: 2, inputTokens: 100, cacheReadTokens: 10 },
    });
  });
});
