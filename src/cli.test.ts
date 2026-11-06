import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as runCli, parseContext, unattendedApproval } from './cli.js';
import { fix, hangman } from './patterns/index.js';
import { LiveRuns } from './runtime/live.js';

const cwd = mkdtempSync(join(tmpdir(), 'symphony-cli-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

/**
 * main(), tracked: a test that times out does not stop its main(), which would go on writing
 * into the next test's output. Each test waits here for whatever it started.
 */
const running = new Set<Promise<unknown>>();
const main: typeof runCli = (...args) => {
  const p = runCli(...args);
  running.add(p);
  void p.then(
    () => running.delete(p),
    () => running.delete(p),
  );
  return p;
};
afterEach(async () => {
  await Promise.allSettled(running);
}, 300_000);

let out = '';
// oxlint-disable-next-line no-control-regex
const plain = () => out.replace(/\x1b\[[0-9;]*m/g, '');
beforeEach(() => {
  out = '';
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out += `${a.join(' ')}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    out += `${a.join(' ')}\n`;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
});

describe('parseContext', () => {
  it('coerces by field type', () => {
    expect(parseContext(['maxWrong=3', 'guessed=a,b', 'won=true', 'word=hi'], hangman)).toEqual({
      maxWrong: 3,
      guessed: ['a', 'b'],
      won: true,
      word: 'hi',
    });
    expect(parseContext(['files=["a.ts"]'], fix)).toEqual({ files: ['a.ts'] });
  });

  it('rejects unknown keys and bad pairs', () => {
    expect(() => parseContext(['nope=1'], hangman)).toThrow(/not a state field/);
    expect(() => parseContext(['=1'], hangman)).toThrow(/key=value/);
  });
});

describe('main', () => {
  it('lists patterns', async () => {
    expect(await main(['list'], cwd)).toBe(0);
    expect(out).toMatch(/hangman/);
    expect(out).toMatch(/needs: issue/);
  });

  it('runs a pattern end to end, saves it and verifies the replay', async () => {
    expect(await main(['run', 'fix', '--auto-approve'], cwd)).toBe(0);
    expect(out).toMatch(/✔ success/);
    const saved = /saved (\S+\.json)/.exec(out)?.[1];
    expect(saved).toBeDefined();
    out = '';
    expect(await main(['verify', saved!], cwd)).toBe(0);
    expect(out).toMatch(/reproduced exactly/);
    out = '';
    // An offline-demo run: hidden from the list unless --all.
    expect(await main(['runs'], cwd)).toBe(0);
    expect(plain()).not.toMatch(/fix\s+success/);
    expect(plain()).toMatch(/\d+ offline-demo runs hidden \(--all to show them\)/);
    out = '';
    expect(await main(['runs', '--all'], cwd)).toBe(0);
    expect(plain()).toMatch(/fix\s+success .*\(demo\)/);
    out = '';
    // Retention: today's runs are kept; a dry run only reports.
    expect(await main(['runs', '--prune', '--dry-run'], cwd)).toBe(0);
    expect(plain()).toMatch(/would delete 0 old demo run\(s\), compact 0 old run\(s\)/);
    expect(existsSync(join(cwd, '.symphony', 'runs', '.last-prune'))).toBe(true);
  });

  it('eval runs a task in its own fixture, saves a report and compares with a baseline', async () => {
    const args = ['eval', '--provider', 'scripted', '--task', 'investigate-default-port'];
    expect(await main(args, cwd)).toBe(0);
    // The offline demo's canned answer is not about this fixture: the check catches it.
    expect(plain()).toMatch(/✘ investigate-default-port/);
    expect(plain()).toMatch(/solved 0\/1/);
    const report = /saved (\S+\.json)/.exec(plain())![1]!;
    expect(JSON.parse(readFileSync(report, 'utf8')).results[0].notes.join(' ')).toMatch(
      /missing: 8081/,
    );
    out = '';
    // The baseline without its times: the time gate compares the machine's load on runs this
    // short, not the code (a loaded machine made this exit 2). The gate has its own tests.
    const saved = JSON.parse(readFileSync(report, 'utf8')) as { results: { ms: number }[] };
    for (const r of saved.results) r.ms = 0;
    writeFileSync(report, JSON.stringify(saved));
    expect(await main([...args, '--compare', report], cwd)).toBe(0);
    expect(plain()).toMatch(/solved 0\/1 \(baseline 0\/1\)/);
    expect(await main(['eval', '--task', 'nope'], cwd)).toBe(1);
  }, 60_000);

  it('eval --with sets an input on the tasks whose pattern has it, and the report says so', async () => {
    const args = ['eval', '--provider', 'scripted', '--task', 'investigate-default-port'];
    out = '';
    expect(
      await main([...args, '--with', 'maxExpandRounds=0', '--with', 'gapAimed=true'], cwd),
    ).toBe(0);
    expect(plain()).toMatch(/^with maxExpandRounds=0 gapAimed=true$/m);
    const report = JSON.parse(readFileSync(/saved (\S+\.json)/.exec(plain())![1]!, 'utf8'));
    expect(report.settings).toEqual(['maxExpandRounds=0', 'gapAimed=true']);
    const run = JSON.parse(
      readFileSync(/run (\S+\.json)/.exec(report.results[0].notes.join(' '))![1]!, 'utf8'),
    );
    expect(run.score.context).toMatchObject({ maxExpandRounds: 0, gapAimed: true });
    // An improvisation level too, named in the report.
    out = '';
    expect(await main([...args, '--improvisation', '2'], cwd)).toBe(0);
    const at2 = JSON.parse(readFileSync(/saved (\S+\.json)/.exec(plain())![1]!, 'utf8'));
    expect(at2.settings).toEqual(['improvisation=2']);
    const run2 = JSON.parse(
      readFileSync(/run (\S+\.json)/.exec(at2.results[0].notes.join(' '))![1]!, 'utf8'),
    );
    expect(run2.score.improvisation).toBe(2);
    // A complexity pinned for every task (the tasks' own ratings are skipped), named too.
    out = '';
    expect(await main([...args, '--complexity', '3'], cwd)).toBe(0);
    const at3 = JSON.parse(readFileSync(/saved (\S+\.json)/.exec(plain())![1]!, 'utf8'));
    expect(at3.settings).toEqual(['complexity=3']);
    const run3 = JSON.parse(
      readFileSync(/run (\S+\.json)/.exec(at3.results[0].notes.join(' '))![1]!, 'utf8'),
    );
    expect(run3.score.complexity).toBe(3);
    out = '';
    expect(await main([...args, '--with', 'noSuchField=1'], cwd)).toBe(1);
    expect(plain()).toMatch(/--with: no task's pattern has 'noSuchField=1'/);
    out = '';
    expect(await main([...args, '--with', 'maxExpandRounds=lots'], cwd)).toBe(1);
  }, 60_000);

  it('two offline runs are identical even though the first one changes the runs folder', async () => {
    const saved: string[] = [];
    for (let i = 0; i < 2; i++) {
      out = '';
      expect(await main(['run', 'investigate', '--auto-approve'], cwd)).toBe(0);
      saved.push(/saved (\S+\.json)/.exec(out)![1]!);
    }
    out = '';
    expect(await main(['compare', ...saved], cwd)).toBe(0);
    expect(plain()).toMatch(/identical performances/);
    out = '';
    expect(await main(['run', 'investigate', '-c', 'question=Other?', '--auto-approve'], cwd)).toBe(
      0,
    );
    const other = /saved (\S+\.json)/.exec(out)![1]!;
    out = '';
    expect(await main(['compare', saved[0]!, other], cwd)).toBe(3);
    expect(plain()).toMatch(/first divergence: the plan[\s\S]*goal, context differ/);
  });

  it('rehearses a score and reports per-node agreement', async () => {
    expect(await main(['rehearse', 'hangman', '-n', '1'], cwd)).toBe(1);
    expect(plain()).toMatch(/--times must be a whole number from 2 to 20/);
    out = '';
    expect(await main(['rehearse', 'hangman', '-n', '2', '--no-save'], cwd)).toBe(0);
    expect(plain()).toMatch(/rehearsal 2 performances of hangman/);
    expect(plain()).toMatch(/pick\s+agent\s+2\/2\s+1\s+100%/);
    expect(plain()).toMatch(/7\/7 nodes played the same notes every time/);
  });

  it('resumes an interrupted run and forks a finished one', async () => {
    expect(await main(['run', 'fix', '--auto-approve'], cwd)).toBe(0);
    const saved = /saved (\S+\.json)/.exec(out)![1]!;
    const run = JSON.parse(readFileSync(saved, 'utf8'));
    // What a crash leaves behind: the last checkpoint, still in progress.
    const crashed = join(cwd, 'crashed.json');
    const cut = {
      ...run.performance,
      outcome: 'in-progress',
      steps: run.performance.steps.slice(0, 3),
    };
    delete cut.completedAt;
    delete cut.reason;
    writeFileSync(crashed, JSON.stringify({ ...run, performance: cut }));

    out = '';
    expect(await main(['resume', saved], cwd)).toBe(1);
    expect(plain()).toMatch(/already ended \(success\); fork it/);
    out = '';
    expect(await main(['resume', crashed, '--auto-approve'], cwd)).toBe(0);
    expect(plain()).toMatch(/resuming .*crashed\.json: steps 1\.\.3 replayed/);
    const resumed = /saved (\S+\.json)/.exec(out)![1]!;
    out = '';
    expect(await main(['compare', saved, resumed], cwd)).toBe(0);
    out = '';
    expect(await main(['verify', resumed], cwd)).toBe(0);

    out = '';
    expect(await main(['fork', saved, '--at', '99'], cwd)).toBe(1);
    out = '';
    expect(await main(['fork', saved, '--at', '2', '--auto-approve'], cwd)).toBe(0);
    const forked = /saved (\S+\.json)/.exec(out)![1]!;
    expect(forked).not.toBe(saved);
    expect(JSON.parse(readFileSync(forked, 'utf8')).performance.basedOn).toEqual({
      kind: 'forked',
      from: saved,
      throughStep: 1,
    });
    out = '';
    expect(await main(['verify', forked], cwd)).toBe(0);
  });

  it('publishes the run it plays, so the studio shows it running and can steer it', async () => {
    const live = mkdtempSync(join(tmpdir(), 'symphony-cli-live-'));
    vi.stubEnv('SYMPHONY_LIVE', '');
    vi.stubEnv('SYMPHONY_LIVE_DIR', live);
    try {
      expect(await main(['run', 'fix', '--auto-approve'], cwd)).toBe(0);
      const [run] = await new LiveRuns(live).list();
      expect(run).toMatchObject({ source: 'cli', workspace: cwd, status: 'done' });
      expect(run?.score.pattern).toBe('fix');
    } finally {
      vi.unstubAllEnvs();
      rmSync(live, { recursive: true, force: true });
    }
  });

  it('never approves for a real AI when nobody is at a terminal', () => {
    expect(unattendedApproval('copilot')).toBe('stop');
    expect(unattendedApproval('scripted')).toBe('demo-answer');
  });

  it('chains patterns with --then: the next gets what the previous found', async () => {
    expect(
      await main(
        [
          'run',
          'investigate',
          '--then',
          'fix',
          '-c',
          'question=Why?',
          '-c',
          'fix.hint=look at paginate',
          '--auto-approve',
        ],
        cwd,
      ),
    ).toBe(0);
    expect(plain()).toMatch(/♪ then fix with what investigate found/);
    const saved = [...plain().matchAll(/saved (\S+\.json)/g)].map((m) => m[1]!);
    expect(saved).toHaveLength(2);
    const second = JSON.parse(readFileSync(saved[1]!, 'utf8'));
    expect(second.score.pattern).toBe('fix');
    expect(second.score.context.hint).toBe('look at paginate');
    expect(second.score.context.issue).toMatch(/^Why\?\n\n## What the investigate run found/);
    expect(second.performance.outcome).toBe('success');
  });

  it('plays a backlog: one run per item, with a summary of how each went', async () => {
    expect(
      await main(
        ['run', 'backlog', '-c', 'source=doc.md', '-c', 'testCommand=npm test', '--auto-approve'],
        cwd,
      ),
    ).toBe(0);
    expect(plain()).toMatch(/♪ implement: Add a --json flag.*\(1 more queued\)/);
    expect(plain()).toMatch(
      /♪ backlog\n {2}✓ success +Add a --json flag[^\n]*\n {2}✓ success +Show the premium/,
    );
    const saved = [...plain().matchAll(/saved (\S+\.json)/g)].map((m) => m[1]!);
    expect(saved).toHaveLength(3);
    const item = JSON.parse(readFileSync(saved[2]!, 'utf8'));
    expect(item.score.goal).toMatch(/^Show the premium requests/);
    expect(item.score.context.testCommand).toBe('npm test');
  });

  it('reports compile errors for missing context', async () => {
    expect(await main(['run', 'review', '-c', 'target=', '--no-save'], cwd)).toBe(1);
    expect(out).toMatch(/missing required context 'target'/);
  });

  it('drafts and saves a TypeScript pattern that is then listed', async () => {
    expect(await main(['draft', 'Rename the config loader', '--save'], cwd)).toBe(0);
    expect(out).toMatch(/valid draft/);
    out = '';
    await main(['list'], cwd);
    expect(out).toMatch(/rename-the-config-loader/);
  });

  it('maestro composes a score and performs it', async () => {
    expect(
      await main(['maestro', 'Fix the flaky login test', '--auto-approve', '--no-save'], cwd),
    ).toBe(0);
    expect(plain()).toMatch(/maestro score .* 🎻 Classical/);
    expect(out).toMatch(/composed 'fix'/);
    expect(plain()).toMatch(/fix score .* complexity 3/);
    expect(out).toMatch(/reached end 'fixed'/);
  });

  it('maestro --compose-only stops after composing', async () => {
    expect(
      await main(
        ['maestro', 'Fix the flaky login test', '--auto-approve', '--no-save', '--compose-only'],
        cwd,
      ),
    ).toBe(0);
    expect(plain()).toMatch(/♪ composed 'fix' complexity 3/);
    expect(plain()).not.toMatch(/performing the composed score/);
  });

  it('maestro --complexity sets the tier: its debate roster and the composed score follow it', async () => {
    const compose = async (tier: string) => {
      out = '';
      const args = [
        'maestro',
        'Fix the flaky login test',
        '--auto-approve',
        '--no-save',
        '--compose-only',
      ];
      expect(await main([...args, '--complexity', tier], cwd)).toBe(0);
      const steps =
        plain()
          .match(/^\[\d+\] \w+ agent/gm)
          ?.map((l) => l.split(' ')[1]) ?? [];
      return { steps, text: plain() };
    };
    const one = await compose('1');
    expect(one.text).toMatch(/maestro score .* complexity 1/);
    expect(one.text).toMatch(/♪ composed 'fix' complexity 1/);
    expect(one.steps).toEqual(['classify', 'cover', 'context']);
    const four = await compose('4');
    expect(four.text).toMatch(/♪ composed 'fix' complexity 4/);
    expect(four.steps).toEqual([
      'classify',
      'propose',
      'skeptic',
      'pragmatist',
      'critic',
      'revise',
      'cover',
      'context',
    ]);
    await expect(main(['maestro', 'x', '--complexity', '5', '--no-save'], cwd)).rejects.toThrow(
      /1, 2, 3 or 4/,
    );
  });

  it('accepts complexity and improvisation by name', async () => {
    expect(
      await main(
        ['run', 'analyze', '-i', 'bebop', '--complexity', '4', '--auto-approve', '--no-save'],
        cwd,
      ),
    ).toBe(0);
    expect(plain()).toMatch(/complexity 4 · 🎺 Bebop/);
    await expect(main(['run', 'analyze', '-i', 'polka', '--no-save'], cwd)).rejects.toThrow(
      /--improvisation/,
    );
  });
});
