import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KEEP_ANSWER, type Provider } from '../runtime/provider.js';
import { RunManager, type RunView } from './runs.js';

/** The demo AI, except that its first step keeps working until the time limit stops it. */
vi.mock('../runtime/factory.js', async (original) => {
  const real = await original<typeof import('../runtime/factory.js')>();
  return {
    ...real,
    makeProvider: (cfg: Parameters<typeof real.makeProvider>[0]): Provider => {
      const demo = real.makeProvider(cfg);
      let first = true;
      return {
        ...demo,
        runAgent: async (req) => {
          if (!first) return demo.runAgent(req);
          first = false;
          await new Promise<void>((resolve) =>
            req.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          if (req.signal.reason !== KEEP_ANSWER) throw new DOMException('aborted', 'AbortError');
          return demo.runAgent({ ...req, signal: new AbortController().signal });
        },
      };
    },
  };
});

const workspace = mkdtempSync(join(tmpdir(), 'symphony-overtime-'));
execFileSync('git', ['init', '-q'], { cwd: workspace });
const live = mkdtempSync(join(tmpdir(), 'symphony-overtime-live-'));
const env = {
  SYMPHONY_MCP: 'off',
  SYMPHONY_LIVE_DIR: live,
  SYMPHONY_HOME: join(live, 'home'),
  SYMPHONY_STATE: 'home',
} as NodeJS.ProcessEnv;
beforeAll(() => {
  vi.stubEnv('SYMPHONY_STEP_TIMEOUT_S', '0.05');
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(live, { recursive: true, force: true });
});
const manager = () =>
  new RunManager({
    workspace: async () => workspace,
    repoRoot: workspace,
    env,
    editsAllowed: true,
  });
const question = {
  question: 'Where are AI responses validated before they change state, and why?',
};

async function settle(runs: RunManager, runId: string): Promise<RunView> {
  for (let i = 0; i < 40; i++) {
    const view = await runs.wait(runId, 5);
    if (view.waitingFor || view.outcome) return view;
  }
  throw new Error('run did not settle');
}

describe('a step over its time limit, from chat', () => {
  it('asks the chat: keep waiting, or stop the step and keep what it has', async () => {
    const runs = manager();
    const id = await runs.start({ pattern: 'investigate', inputs: question, provider: 'scripted' });
    const t0 = Date.now();
    const asked = await runs.wait(id, 5);
    // get_run returns as soon as the run asks, not when its wait runs out.
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(asked.waitingFor).toMatchObject({ kind: 'overtime', minutes: 0 });
    expect(asked.status).toBe('running');
    // Waiting: asked again after another limit, the step never cut off meanwhile.
    expect(runs.answerOvertime(id, 'wait').waitingFor).toBeUndefined();
    expect((await settle(runs, id)).waitingFor).toMatchObject({ kind: 'overtime' });
    runs.answerOvertime(id, 'stop');
    const next = await settle(runs, id);
    expect(next.waitingFor?.kind).not.toBe('overtime');
    expect(() => runs.answerOvertime(id, 'wait')).toThrow('no step is over its time limit');
    await runs.stop(id);
  });

  it('auto-approved, nobody is asked: the step is stopped at the limit', async () => {
    const runs = manager();
    const id = await runs.start({
      pattern: 'investigate',
      inputs: question,
      provider: 'scripted',
      autoApprove: true,
    });
    const view = await settle(runs, id);
    expect(view.waitingFor).toBeUndefined();
    expect(view.outcome).toBe('success');
  });
});
