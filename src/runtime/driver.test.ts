import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { hashOf } from '../core/hash.js';
import { replayPerformance } from '../core/replay.js';
import { fix, hangman } from '../patterns/index.js';
import { performScore, Run, type RunMessage, type RunStatus } from './driver.js';
import type { AgentRequest, AgentResponse, Provider } from './provider.js';
import { ScriptedProvider } from './scripted-provider.js';

const clock = () => 't';
const hangmanScore = compileScore(hangman, { goal: 'play', generatedAt: 't' });
const fixScore = compileScore(fix, { goal: 'fix', context: fix.demo!.context!, generatedAt: 't' });

function waitFor(run: Run, pred: (m: RunMessage) => boolean): Promise<RunMessage> {
  const hit = run.messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const off = run.subscribe((m) => {
      if (pred(m)) {
        off();
        resolve(m);
      }
    });
  });
}

const statusIs =
  (status: RunStatus, extra: Partial<Record<string, unknown>> = {}) =>
  (m: RunMessage) =>
    m.type === 'status' &&
    m.status === status &&
    Object.entries(extra).every(([k, v]) => (m as unknown as Record<string, unknown>)[k] === v);

describe('Run', () => {
  it('runs a full flow with auto-approval and reproduces on replay', async () => {
    const run = new Run({
      score: fixScore,
      provider: ScriptedProvider.forPattern(fix),
      demo: fix.demo,
      autoApprove: true,
      clock,
    });
    const perf = await run.start();
    expect(perf.outcome).toBe('success');
    expect(run.status).toBe('done');
    expect(run.messages.some((m) => m.type === 'provider' && m.event.type === 'delta')).toBe(true);
    expect(replayPerformance(fixScore, perf).divergence.reproduced).toBe(true);
  });

  it('is deterministic across runs', async () => {
    const mk = () =>
      new Run({
        score: fixScore,
        provider: ScriptedProvider.forPattern(fix),
        demo: fix.demo,
        autoApprove: true,
        clock,
      }).start();
    expect(hashOf(await mk())).toBe(hashOf(await mk()));
  });

  it('waits for a human at approval nodes', async () => {
    const run = new Run({
      score: hangmanScore,
      provider: ScriptedProvider.forPattern(hangman),
      demo: hangman.demo,
      clock,
    });
    const done = run.start();
    const asked = () =>
      run.messages.filter((m) => m.type === 'status' && m.status === 'awaiting-approval').length;
    for (const [i, letter] of ['p', 'l', 'a', 'n', 'e', 't'].entries()) {
      await waitFor(run, () => asked() === i + 1);
      expect(run.answerApproval({ approved: true, updates: { letter } })).toBeUndefined();
    }
    const perf = await done;
    expect(perf.outcome).toBe('success');
    expect(perf.finalState.won).toBe(true);
  });

  it('pauses at breakpoints before and after the AI, exposing the proposed result', async () => {
    const run = new Run({
      score: fixScore,
      provider: ScriptedProvider.forPattern(fix),
      demo: fix.demo,
      autoApprove: true,
      breakpoints: ['diagnose'],
      clock,
    });
    const done = run.start();
    await waitFor(run, statusIs('paused', { nodeId: 'diagnose', phase: 'before' }));
    expect(run.engine.state.rootCause).toBe('');
    run.resume();
    const after = await waitFor(run, statusIs('paused', { nodeId: 'diagnose', phase: 'after' }));
    expect(after.type === 'status' && after.proposed).toMatchObject({
      updates: { files: ['src/paginate.ts'] },
    });
    expect(run.engine.state.rootCause).toBe('');
    run.setBreakpoints([]);
    run.resume();
    expect((await done).outcome).toBe('success');
  });

  it('step mode stops at every gate', async () => {
    const run = new Run({
      score: hangmanScore,
      provider: ScriptedProvider.forPattern(hangman),
      demo: hangman.demo,
      autoApprove: true,
      stepMode: true,
      clock,
    });
    const done = run.start();
    await waitFor(run, statusIs('paused', { nodeId: 'pick', phase: 'before' }));
    run.step();
    await waitFor(run, statusIs('paused', { nodeId: 'pick', phase: 'after' }));
    run.setStepMode(false);
    run.resume();
    expect((await done).outcome).toBe('success');
  });

  it('stop aborts the live AI call and cancels the run', async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const hanging: Provider = {
      name: 'hanging',
      runAgent: (req: AgentRequest) =>
        new Promise<AgentResponse>((_resolve, reject) => {
          req.onEvent({ type: 'delta', text: 'partial output' });
          started();
          req.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
      draft: () => Promise.reject(new Error('n/a')),
    };
    const run = new Run({ score: hangmanScore, provider: hanging, clock });
    const done = run.start();
    await begun;
    run.stop();
    const perf = await done;
    expect(perf.outcome).toBe('cancelled');
    expect(perf.reason).toMatch(/stopped by user at 'pick'/);
    expect(run.status).toBe('cancelled');
    expect(
      run.messages.some(
        (m) =>
          m.type === 'provider' && m.event.type === 'delta' && m.event.text === 'partial output',
      ),
    ).toBe(true);
  });

  it('turns provider errors into rejected responses and fails after retries', async () => {
    const broken: Provider = {
      name: 'broken',
      runAgent: () => Promise.reject(new Error('network down')),
      draft: () => Promise.reject(new Error('n/a')),
    };
    const perf = await new Run({ score: hangmanScore, provider: broken, clock }).start();
    expect(perf.outcome).toBe('failed');
    expect(perf.reason).toMatch(/no valid response after 3 attempt/);
    expect(perf.steps.at(-1)?.attempts?.[0]?.transcript?.output).toMatch(/network down/);
  });

  it('records envHash and saves the run', async () => {
    const saved: unknown[] = [];
    const run = new Run({
      score: fixScore,
      provider: ScriptedProvider.forPattern(fix),
      demo: fix.demo,
      autoApprove: true,
      clock,
      envHash: async () => 'env-1',
      onSave: async (r) => {
        saved.push(r);
        return '/tmp/x.json';
      },
    });
    const perf = await run.start();
    expect(perf.steps.find((s) => s.nodeId === 'apply')?.envHash).toBe('env-1');
    expect(saved).toHaveLength(1);
    expect(run.messages.find((m) => m.type === 'performance')).toMatchObject({
      savedTo: '/tmp/x.json',
    });
  });

  it('performScore runs a score to completion', async () => {
    const perf = await performScore(fixScore, ScriptedProvider.forPattern(fix), {
      demo: fix.demo,
      autoApprove: true,
      clock,
    });
    expect(perf.outcome).toBe('success');
  });

  it('accepts answers given synchronously from a status listener', async () => {
    const run = new Run({
      score: hangmanScore,
      provider: ScriptedProvider.forPattern(hangman),
      demo: hangman.demo,
      breakpoints: ['pick'],
      clock,
    });
    run.subscribe((m) => {
      if (m.type === 'status' && m.status === 'paused') run.resume();
      if (m.type === 'status' && m.status === 'awaiting-approval')
        run.answerApproval({ approved: true, scripted: true });
    });
    const perf = await run.start();
    expect(perf.outcome).toBe('success');
  });
});
