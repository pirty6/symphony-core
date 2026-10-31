import { describe, expect, it } from 'vitest';
import type { AiTranscript, PerformedStep, TokenUsage } from './types.js';
import {
  costliest,
  formatUsage,
  performanceUsage,
  growth,
  rejectionUsage,
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
    expect(top[0]!.text).toMatch(/^90k in · 9k out · 1 calls · 3 premium requests$/);
  });

  it('reads well', () => {
    expect(formatUsage({ ...u(1_234_000, 45_000, 37), cacheReadTokens: 800_000 })).toBe(
      '1.2M in (800k cached) · 45k out · 37 calls',
    );
    expect(formatUsage(u(0, 0, 0))).toBe('no AI tokens');
  });
});
