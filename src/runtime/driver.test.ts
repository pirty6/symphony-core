import { describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { hashOf } from '../core/hash.js';
import { replayPerformance, restoreEngine, RestoreError } from '../core/replay.js';
import type { Pattern, SavedRun } from '../core/types.js';
import { fix, hangman } from '../patterns/index.js';
import { performScore, Run, type RunMessage, type RunStatus } from './driver.js';
import { KEEP_ANSWER, type AgentRequest, type AgentResponse, type Provider } from './provider.js';
import { ScriptedProvider } from './scripted-provider.js';
import { registry } from './tools.js';
import { repertoireFrom } from './repertoire.js';

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
    expect(perf.provider).toBe('scripted');
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
      updates: { files: ['src/paginate.ts', 'src/paginate.test.ts'] },
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
    // Unattended (auto-approve): nobody can retry a stuck step, so it fails as before.
    const perf = await new Run({
      score: hangmanScore,
      provider: broken,
      clock,
      autoApprove: true,
    }).start();
    expect(perf.outcome).toBe('partial');
    expect(perf.reason).toMatch(/no valid response after 3 attempt/);
    expect(perf.steps.at(-1)?.attempts?.[0]?.transcript?.output).toMatch(/network down/);
    expect(perf.steps.at(-1)?.recoveries).toEqual([{ action: 'stop', by: 'scripted', at: 't' }]);
  });

  it('a stuck step waits for a human, who can retry it with a hint and a smarter tier', async () => {
    const seen: AgentRequest[] = [];
    let fail = true;
    const flaky: Provider = {
      name: 'flaky',
      runAgent: async (req) => {
        seen.push(req);
        if (fail) throw new Error('HTTP 429');
        return {
          result: {
            updates: { word: 'cat' },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          },
          transcript: { provider: 'flaky', prompt: '', output: 'cat', toolCalls: [] },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const run = new Run({ score: hangmanScore, provider: flaky, clock });
    const done = run.start();
    await waitFor(run, (m) => m.type === 'status' && m.status === 'awaiting-approval');
    expect(run.engine.pause).toMatchObject({ kind: 'stuck', nodeId: 'pick', attempts: 3 });
    expect(run.answerApproval({ approved: true })).toBe('no approval is pending');
    fail = false;
    expect(
      run.answerRecovery({ action: 'retry', hint: 'try again later', complexity: 4 }),
    ).toBeUndefined();
    await waitFor(
      run,
      (m) =>
        m.type === 'status' &&
        m.status === 'awaiting-approval' &&
        run.engine.pause?.kind === 'approval',
    );
    expect(seen.at(-1)!.pause).toMatchObject({ attempt: 4, complexity: 4 });
    expect(seen.at(-1)!.pause.feedback?.at(-1)).toMatch(/says: try again later/);
    run.stop('enough');
    const perf = await done;
    const pick = perf.steps.find((s) => s.nodeId === 'pick')!;
    expect(pick.recoveries).toEqual([
      { action: 'retry', hint: 'try again later', complexity: 4, by: 'user', at: 't' },
    ]);
    expect(replayPerformance(hangmanScore, perf).divergence.reproduced).toBe(true);
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

  it('the offline demo plays its recorded tool outputs; a live provider reads the real tool', async () => {
    const p: Pattern = {
      name: 't',
      description: 'd',
      requiredContext: [],
      state: [{ name: 'files', type: 'string[]' }],
      start: 's',
      nodes: [
        { id: 's', kind: 'start', label: 'S' },
        { id: 'list', kind: 'tool', label: 'L', tool: 'repo.files', output: { files: 'files' } },
        { id: 'e', kind: 'end', label: 'E' },
      ],
      edges: [
        { id: '1', from: 's', to: 'list' },
        { id: '2', from: 'list', to: 'e' },
      ],
      demo: { tools: { list: () => ({ files: ['demo.ts'] }) } },
    };
    const score = compileScore(p, { goal: 'g', generatedAt: 't' });
    let calls = 0;
    const tools = registry([
      {
        name: 'repo.files',
        description: 'd',
        outputs: ['files'],
        run: async () => ({ files: [`real-${++calls}.ts`] }),
      },
    ]);
    const offline = async () =>
      (
        await new Run({
          score,
          provider: new ScriptedProvider(),
          demo: p.demo,
          tools,
          clock,
        }).start()
      ).finalState;
    expect(await offline()).toEqual({ files: ['demo.ts'] });
    expect(await offline()).toEqual({ files: ['demo.ts'] });
    expect(calls).toBe(0);
    const live: Provider = {
      name: 'live',
      runAgent: async () => Promise.reject(new Error('unused')),
      draft: async () => Promise.reject(new Error('unused')),
    };
    const perf = await new Run({ score, provider: live, demo: p.demo, tools, clock }).start();
    expect(perf.finalState).toEqual({ files: ['real-1.ts'] });
  });

  it('tools get the whole tool context: a worktree run keeps memory in your workspace', async () => {
    const seen: unknown[] = [];
    const p: Pattern = {
      name: 't',
      description: 'd',
      requiredContext: [],
      state: [{ name: 'files', type: 'string[]' }],
      start: 's',
      nodes: [
        { id: 's', kind: 'start', label: 'S' },
        { id: 'list', kind: 'tool', label: 'L', tool: 'repo.files', output: { files: 'files' } },
        { id: 'e', kind: 'end', label: 'E' },
      ],
      edges: [
        { id: '1', from: 's', to: 'list' },
        { id: '2', from: 'list', to: 'e' },
      ],
    };
    const tools = registry([
      {
        name: 'repo.files',
        description: 'd',
        outputs: ['files'],
        run: async (_a, ctx) => {
          seen.push(ctx.memoryRoot);
          return { files: [] };
        },
      },
    ]);
    const live: Provider = {
      name: 'live',
      runAgent: async () => Promise.reject(new Error('unused')),
      draft: async () => Promise.reject(new Error('unused')),
    };
    await new Run({
      score: compileScore(p, { goal: 'g', generatedAt: 't' }),
      provider: live,
      tools,
      toolContext: { workspace: '/tree', repoRoot: '/r', memoryRoot: '/home' },
      clock,
    }).start();
    expect(seen).toEqual(['/home']);
  });

  it('runs tool nodes through the registry, gated and recorded', async () => {
    const p = {
      name: 't',
      description: 'd',
      requiredContext: [],
      state: [{ name: 'files', type: 'string[]' as const }],
      start: 's',
      nodes: [
        { id: 's', kind: 'start' as const, label: 'S' },
        {
          id: 'list',
          kind: 'tool' as const,
          label: 'L',
          tool: 'repo.files',
          output: { files: 'files' },
        },
        { id: 'e', kind: 'end' as const, label: 'E' },
      ],
      edges: [
        { id: '1', from: 's', to: 'list' },
        { id: '2', from: 'list', to: 'e' },
      ],
    };
    const score = compileScore(p, { goal: 'g', generatedAt: 't' });
    const tools = registry([
      {
        name: 'repo.files',
        description: 'd',
        outputs: ['files', 'excluded'],
        run: async () => ({ files: ['a.ts'], excluded: [] }),
      },
    ]);
    const run = new Run({
      score,
      provider: new ScriptedProvider(),
      tools,
      breakpoints: ['list'],
      clock,
    });
    const done = run.start();
    await waitFor(run, statusIs('paused', { nodeId: 'list', phase: 'before' }));
    run.resume();
    await waitFor(run, statusIs('paused', { nodeId: 'list', phase: 'after' }));
    const after = run.messages.find((m) => m.type === 'status' && m.phase === 'after');
    expect(after?.type === 'status' && after.proposed).toEqual({ files: ['a.ts'] });
    run.setBreakpoints([]);
    run.resume();
    const perf = await done;
    expect(perf).toMatchObject({ outcome: 'success', finalState: { files: ['a.ts'] } });
    expect(replayPerformance(score, perf).divergence.reproduced).toBe(true);

    const unknown = await new Run({
      score,
      provider: new ScriptedProvider(),
      tools: registry([]),
      clock,
    }).start();
    expect(unknown.reason).toMatch(/unknown tool 'repo.files'/);
    const broken = registry([
      {
        name: 'repo.files',
        description: 'd',
        outputs: ['files'],
        run: async () => {
          throw new Error('git not found');
        },
      },
    ]);
    expect(
      (await new Run({ score, provider: new ScriptedProvider(), tools: broken, clock }).start())
        .reason,
    ).toMatch(/git not found/);
  });

  it('classical: same song, same notes — replays the repertoire instead of asking again', async () => {
    const asked: string[] = [];
    const flaky: Provider = {
      name: 'flaky',
      runAgent: async (req) => {
        asked.push(req.pause.nodeId);
        const word = `w${asked.length}x`;
        return {
          result: {
            updates: { word },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          },
          transcript: { provider: 'flaky', prompt: '', output: `picked ${word}`, toolCalls: [] },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const score = compileScore(hangman, { goal: 'g', improvisation: 0, generatedAt: 't' });
    const first = await new Run({
      score,
      provider: flaky,
      demo: hangman.demo,
      autoApprove: true,
      clock,
    }).start();
    expect(asked).toEqual(['pick']);
    const repertoire = repertoireFrom([
      { run: { schemaVersion: 3, score, performance: first }, file: 'first.json' },
    ]);
    const run2 = new Run({
      score,
      provider: flaky,
      demo: hangman.demo,
      autoApprove: true,
      clock,
      repertoire,
    });
    const second = await run2.start();
    expect(asked).toEqual(['pick']);
    expect(second.finalState).toEqual(first.finalState);
    expect(second.steps.find((s) => s.nodeId === 'pick')?.transcript?.fromRepertoire).toBe(
      'first.json',
    );
    expect(
      run2.messages.some(
        (m) => m.type === 'provider' && m.event.type === 'info' && /same notes/.test(m.event.text),
      ),
    ).toBe(true);

    const jazz = compileScore(hangman, { goal: 'g', improvisation: 1, generatedAt: 't' });
    const jazzRep = repertoireFrom([
      { run: { schemaVersion: 3, score: jazz, performance: first }, file: 'x' },
    ]);
    await new Run({
      score: jazz,
      provider: flaky,
      demo: hangman.demo,
      autoApprove: true,
      clock,
      repertoire: jazzRep,
    }).start();
    expect(asked).toEqual(['pick', 'pick']);
  });

  it('classical replays only answers recorded with the model settings the step asks for now', async () => {
    let calls = 0;
    const musician = (model: string): Provider => ({
      name: 'copilot',
      requested: async () => `${model}/high`,
      runAgent: async (req) => {
        calls += 1;
        return {
          result: {
            updates: { word: `${model}word` },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          },
          transcript: {
            provider: 'copilot',
            model,
            prompt: '',
            output: '',
            toolCalls: [],
            musician: {
              tier: req.pause.complexity,
              requestedModel: model,
              effort: 'high',
              sampling: 'n/a',
            },
          },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    });
    const score = compileScore(hangman, { goal: 'g', improvisation: 0, generatedAt: 't' });
    const play = (provider: Provider, repertoire?: ReturnType<typeof repertoireFrom>) =>
      new Run({
        score,
        provider,
        demo: hangman.demo,
        autoApprove: true,
        clock,
        ...(repertoire ? { repertoire } : {}),
      }).start();
    const first = await play(musician('sonnet'));
    const repertoire = repertoireFrom([
      { run: { schemaVersion: 3, score, performance: first }, file: 'f.json' },
    ]);
    expect(calls).toBe(1);
    // The same settings: replayed. Another model: played again, not passed off as identical.
    await play(musician('sonnet'), repertoire);
    expect(calls).toBe(1);
    const other = await play(musician('opus'), repertoire);
    expect(calls).toBe(2);
    expect(other.finalState.word).toBe('opusword');
  });

  it('bebop: plays takes in parallel and lets the bandleader merge them', async () => {
    const calls: { take?: number; integrate?: number }[] = [];
    const band: Provider = {
      name: 'band',
      runAgent: async (req) => {
        calls.push({
          ...(req.take ? { take: req.take } : {}),
          ...(req.integrate ? { integrate: req.integrate.length } : {}),
        });
        const word = req.integrate ? 'merged' : `take${req.take}`;
        req.onEvent({ type: 'info', text: word });
        return {
          result: {
            updates: { word },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          },
          transcript: { provider: 'band', prompt: '', output: word, toolCalls: [] },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const score = compileScore(hangman, { goal: 'g', improvisation: 4, generatedAt: 't' });
    const run = new Run({ score, provider: band, demo: hangman.demo, autoApprove: true, clock });
    const perf = await run.start();
    expect(calls).toEqual([{ take: 1 }, { take: 2 }, { take: 3 }, { integrate: 3 }]);
    expect(perf.finalState.word).toBe('merged');
    expect(
      perf.steps.find((s) => s.nodeId === 'pick')?.transcript?.takes?.map((t) => t.output),
    ).toEqual(['take1', 'take2', 'take3']);
    expect(
      run.messages.filter((m) => m.type === 'provider').map((m) => m.type === 'provider' && m.take),
    ).toEqual([1, 2, 3, 0]);
    expect(replayPerformance(score, perf).divergence.reproduced).toBe(true);
  });
});

const offline = () => ScriptedProvider.forPattern(fix);
const strip = ({ basedOn: _b, ...p }: SavedRun['performance']) => p;

describe('checkpoints, resume and fork', () => {
  async function checkpoints(): Promise<SavedRun[]> {
    const saved: SavedRun[] = [];
    await new Run({
      score: fixScore,
      provider: offline(),
      demo: fix.demo,
      autoApprove: true,
      clock,
      checkpoint: true,
      onSave: async (r) => {
        saved.push(structuredClone(r));
        return 'f.json';
      },
    }).start();
    return saved;
  }

  it('saves the run after every answer, then once more at the end', async () => {
    const saved = await checkpoints();
    const done = saved.at(-1)!.performance;
    expect(done.outcome).toBe('success');
    const answered = done.steps.filter((s) => ['agent', 'tool', 'approval'].includes(s.kind));
    expect(saved).toHaveLength(answered.length);
    expect(saved.slice(0, -1).every((r) => r.performance.outcome === 'in-progress')).toBe(true);
    const sizes = saved.map((r) => r.performance.steps.length);
    expect(sizes).toEqual(sizes.toSorted((a, b) => a - b));
  });

  it('a run cut off at any step resumes to exactly the uninterrupted performance', async () => {
    const saved = await checkpoints();
    const whole = saved.at(-1)!.performance;
    for (const cut of [0, 3, saved.length - 3]) {
      const partial = saved[cut]!.performance;
      if (cut > 0) expect(replayPerformance(fixScore, partial).divergence.reproduced).toBe(true);
      const restored = restoreEngine(fixScore, partial);
      expect(restored.state.kind).toBe('running');
      const resumed = await new Run({
        score: fixScore,
        provider: offline(),
        demo: fix.demo,
        autoApprove: true,
        clock,
        restore: {
          result: restored,
          basedOn: {
            kind: 'resumed',
            from: 'f.json',
            throughStep: partial.steps.at(-1)?.step ?? 0,
          },
        },
      }).start();
      expect(strip(resumed)).toEqual(strip(whole));
      expect(resumed.basedOn).toMatchObject({ kind: 'resumed', from: 'f.json' });
      expect(replayPerformance(fixScore, resumed).divergence.reproduced).toBe(true);
    }
  });

  it('forks a finished run from a step: earlier steps are kept, later ones play again', async () => {
    const original = (await checkpoints()).at(-1)!.performance;
    const diagnose = original.steps.find((s) => s.kind === 'agent')!;
    const restored = restoreEngine(fixScore, original, {
      throughStep: diagnose.step - 1,
      startedAt: 'u',
    });
    expect(restored.state.kind === 'running' && restored.state.pause?.nodeId).toBe(diagnose.nodeId);
    const forked = await new Run({
      score: fixScore,
      provider: offline(),
      demo: fix.demo,
      autoApprove: true,
      clock,
      restore: {
        result: restored,
        basedOn: { kind: 'forked', from: 'f.json', throughStep: diagnose.step - 1 },
      },
    }).start();
    expect(forked.startedAt).toBe('u');
    expect(forked.steps.slice(0, diagnose.step - 1)).toEqual(
      original.steps.slice(0, diagnose.step - 1),
    );
    expect(replayPerformance(fixScore, forked).divergence.reproduced).toBe(true);
  });

  it('refuses to restore answers that do not fit the score', async () => {
    const original = (await checkpoints()).at(-1)!.performance;
    const agent = original.steps.findIndex((s) => s.kind === 'agent');
    const steps = original.steps.map((s, i) => (i === agent ? { ...s, updates: { bogus: 1 } } : s));
    expect(() => restoreEngine(fixScore, { ...original, steps })).toThrow(
      /no longer reproduce the run at step/,
    );
    expect(() => restoreEngine(fixScore, { ...original, steps })).toThrow(RestoreError);
  });
});

describe('scratch cleanup', () => {
  const scratchRun = (provider: Provider) => {
    const removed: string[] = [];
    const run = new Run({
      score: fixScore,
      provider,
      demo: fix.demo,
      autoApprove: true,
      clock,
      scratch: { dir: '/w/.symphony/scratch/r1', remove: async () => void removed.push('r1') },
    });
    return { run, removed };
  };

  it('agents get the folder and it is removed when the run ends', async () => {
    const seen: (string | undefined)[] = [];
    const scripted = ScriptedProvider.forPattern(fix);
    const { run, removed } = scratchRun({
      name: 'spy',
      runAgent: (req) => {
        seen.push(req.scratchDir);
        return scripted.runAgent(req);
      },
      draft: () => Promise.reject(new Error('n/a')),
    });
    expect((await run.start()).outcome).toBe('success');
    expect(new Set(seen)).toEqual(new Set(['/w/.symphony/scratch/r1']));
    expect(removed).toEqual(['r1']);
  });

  it('is removed when the run fails or is stopped too, and a failing removal is ignored', async () => {
    const failing = scratchRun({
      name: 'broken',
      runAgent: async () => ({
        result: 'nope',
        transcript: { provider: 'broken', prompt: '', output: 'nope', toolCalls: [] },
      }),
      draft: () => Promise.reject(new Error('n/a')),
    });
    expect((await failing.run.start()).outcome).not.toBe('success');
    expect(failing.removed).toEqual(['r1']);

    const run = new Run({
      score: fixScore,
      provider: ScriptedProvider.forPattern(fix),
      demo: fix.demo,
      clock,
      scratch: { dir: '/x', remove: () => Promise.reject(new Error('busy')) },
    });
    const done = run.start();
    await waitFor(run, statusIs('awaiting-approval'));
    run.stop();
    expect((await done).outcome).toBe('cancelled');
  });
});

describe('runs in their own worktree', () => {
  it('brings the edits back when the run ends and records where they went', async () => {
    const outcomes: string[] = [];
    const saved: SavedRun[] = [];
    const run = new Run({
      score: fixScore,
      provider: ScriptedProvider.forPattern(fix),
      demo: fix.demo,
      autoApprove: true,
      clock,
      onSave: async (r) => {
        saved.push(r);
        return 'f.json';
      },
      isolation: {
        finish: async (outcome) => {
          outcomes.push(outcome);
          return { kind: 'applied', files: ['src/paginate.ts'] };
        },
      },
    });
    const perf = await run.start();
    expect(outcomes).toEqual(['success']);
    expect(perf.edits).toEqual({ kind: 'applied', files: ['src/paginate.ts'] });
    expect(saved.at(-1)!.performance.edits).toEqual(perf.edits);
    expect(replayPerformance(fixScore, perf).divergence.reproduced).toBe(true);
  });

  it('a failure to collect the edits is recorded, never fails the run', async () => {
    const run = new Run({
      score: fixScore,
      provider: ScriptedProvider.forPattern(fix),
      demo: fix.demo,
      autoApprove: true,
      clock,
      isolation: { finish: () => Promise.reject(new Error('disk full')) },
    });
    const perf = await run.start();
    expect(perf.outcome).toBe('success');
    expect(perf.edits?.reason).toMatch(/disk full/);
  });
});

describe('step time limit', () => {
  it('a step that never answers is stopped, retried, and then waits for a human like any stuck step', async () => {
    let calls = 0;
    const hang: Provider = {
      name: 'hang',
      runAgent: (req) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          req.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
      draft: () => Promise.reject(new Error('n/a')),
    };
    const run = new Run({ score: hangmanScore, provider: hang, stepTimeoutMs: 20, clock });
    const done = run.start();
    await waitFor(run, statusIs('awaiting-approval'));
    expect(calls).toBe(3);
    expect(run.engine.pause).toMatchObject({ kind: 'stuck', nodeId: 'pick' });
    expect(run.engine.pause!.kind === 'stuck' && run.engine.pause!.feedback[0]).toMatch(
      /timed out: the step took longer than 0s/,
    );
    run.stop();
    expect((await done).outcome).toBe('cancelled');
  });
});

describe('time limit: keep what it has, or ask', () => {
  const word = {
    updates: { word: 'planet' },
    verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
  };
  /** Submits a valid answer at once, then keeps working until stopped. */
  const slow = (calls: { n: number }): Provider => ({
    name: 'slow',
    runAgent: (req) =>
      new Promise<AgentResponse>((resolve, reject) => {
        calls.n += 1;
        req.signal.addEventListener('abort', () =>
          req.signal.reason === KEEP_ANSWER
            ? resolve({
                result: word,
                transcript: { provider: 'slow', prompt: '', output: 'kept', toolCalls: [] },
              })
            : reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
    draft: () => Promise.reject(new Error('n/a')),
  });

  it('unattended, a step stopped at the limit keeps the answer it submitted', async () => {
    const calls = { n: 0 };
    const run = new Run({ score: hangmanScore, provider: slow(calls), stepTimeoutMs: 20, clock });
    const done = run.start();
    await waitFor(run, statusIs('awaiting-approval'));
    // Accepted the first time: no retry for a step that had already answered.
    expect(calls.n).toBe(1);
    expect(run.engine.state.word).toBe('planet');
    run.stop();
    await done;
  });

  it('with someone watching, it asks: keep waiting, or stop and keep what it has', async () => {
    const calls = { n: 0 };
    const run = new Run({
      score: hangmanScore,
      provider: slow(calls),
      stepTimeoutMs: 20,
      askOnOvertime: true,
      clock,
    });
    const done = run.start();
    await waitFor(run, (m) => m.type === 'overtime' && m.state === 'asking');
    expect(run.overtime).toMatchObject({ nodeId: 'pick', afterMs: 20 });
    expect(run.answerOvertime('wait')).toBeUndefined();
    // Asked again one limit later; the step was never cut off meanwhile.
    await waitFor(run, (m) => m.type === 'overtime' && m.state === 'asking' && m.afterMs === 40);
    expect(run.answerOvertime('stop')).toBeUndefined();
    await waitFor(run, statusIs('awaiting-approval'));
    expect(calls.n).toBe(1);
    expect(run.engine.state.word).toBe('planet');
    expect(run.answerOvertime('wait')).toBe('no step is over its time limit');
    run.stop();
    await done;
  });
});

describe('fan-out retry', () => {
  const reader: Pattern = {
    name: 'reader',
    description: 'reads in parts',
    requiredContext: ['files'],
    state: [
      { name: 'files', type: 'string[]' },
      { name: 'agents', type: 'number', initial: 2 },
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
        directive: 'read',
        reads: ['files'],
        writes: ['read'],
        fanOut: { over: 'files', per: 1, agents: 'agents' },
        checks: [{ expr: 'subset(files, read)', message: 'Read every file.' }],
      },
      { id: 'end', kind: 'end', label: 'End', outcome: 'success' },
    ],
    edges: [
      { id: 'a', from: 'start', to: 'readAll' },
      { id: 'b', from: 'readAll', to: 'end' },
    ],
  };

  it('plays again only the part that failed, as many at once as the AI chose', async () => {
    const asked: string[] = [];
    let running = 0;
    let most = 0;
    let failedC = false;
    const provider: Provider = {
      name: 'parts',
      runAgent: async (req) => {
        const file = (req.pause.input.files as string[])[0]!;
        asked.push(file);
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        // c fails the first time only.
        const read = file === 'c' && !failedC ? ((failedC = true), []) : [file];
        return {
          result: {
            updates: { read },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: file },
          },
          transcript: { provider: 'parts', prompt: '', output: file, toolCalls: [] },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const score = compileScore(reader, {
      goal: 'g',
      context: { files: ['a', 'b', 'c', 'd'] },
      generatedAt: 't',
    });
    const perf = await new Run({ score, provider, clock }).start();
    expect(perf.outcome).toBe('success');
    expect(asked.toSorted()).toEqual(['a', 'b', 'c', 'c', 'd']);
    expect(most).toBe(2);
    expect(perf.finalState.read).toEqual(['a', 'b', 'c', 'd']);
    expect(replayPerformance(score, perf).divergence.reproduced).toBe(true);
  });
});

describe('setup errors', () => {
  it('a provider that cannot work as configured stops the run at once, saying why', async () => {
    let calls = 0;
    const provider: Provider = {
      name: 'copilot',
      runAgent: async () => {
        calls += 1;
        throw Object.assign(new Error('Copilot is not signed in on this machine.'), {
          name: 'SetupError',
        });
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const perf = await new Run({ score: hangmanScore, provider, clock }).start();
    expect(calls).toBe(1);
    expect(perf.outcome).toBe('cancelled');
    expect(perf.reason).toMatch(/^Copilot is not signed in on this machine\./);
  });
});
