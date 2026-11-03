/**
 * Runs shared between processes on this machine, so a run a VS Code chat started (through the
 * MCP server) shows in the studio, live, and can be steered from there. Each run is a folder
 * under ~/.symphony/live/<run id> (SYMPHONY_LIVE_DIR moves it; SYMPHONY_LIVE=off turns it off):
 *
 * - meta.json: what the run is (its score) and which process plays it;
 * - messages.jsonl: every message of the run, in order, as the studio streams them;
 * - commands.jsonl: what the studio asks (approve, pause, stop…), applied by the playing process.
 *
 * The process that plays the run stays its only owner: the studio never runs it, it only reads
 * and asks.
 */
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecutableScore } from '../core/types.js';
import type { HumanAnswer, RecoveryAnswer, Run, RunMessage, RunStatus } from './driver.js';

/** What the studio's routes need of a run: one played here, or one played by another process. */
export type RunLike = Pick<
  Run,
  | 'id'
  | 'score'
  | 'messages'
  | 'status'
  | 'subscribe'
  | 'pause'
  | 'resume'
  | 'step'
  | 'stop'
  | 'setBreakpoints'
  | 'setStepMode'
  | 'answerOvertime'
  | 'answerRecovery'
  | 'answerApproval'
>;

export interface LiveMeta {
  readonly id: string;
  readonly pattern: string;
  readonly goal: string;
  /** Who plays it: 'chat' (the MCP server, e.g. a VS Code chat). */
  readonly source: string;
  readonly workspace: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly score: ExecutableScore;
}

export type LiveCommand =
  | { readonly action: 'pause' | 'resume' | 'step' | 'stop' | 'keepWaiting' | 'stopStep' }
  | { readonly action: 'breakpoints'; readonly breakpoints: readonly string[] }
  | { readonly action: 'stepMode'; readonly on: boolean }
  | { readonly action: 'approval'; readonly answer: HumanAnswer }
  | { readonly action: 'recovery'; readonly answer: RecoveryAnswer };

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled']);
const POLL_MS = 400;
const FLUSH_MS = 100;
/** Older runs' folders are removed when a new run is published. */
const KEEP_MS = 7 * 24 * 3600_000;
/** The studio lists runs whose folder changed within this. */
const LIST_MS = 24 * 3600_000;

export function liveRoot(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const v = env.SYMPHONY_LIVE?.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return undefined;
  return env.SYMPHONY_LIVE_DIR?.trim() || join(homedir(), '.symphony', 'live');
}

/** Lines not yet read from a file that grows: reads from `offset`, keeps a cut last line. */
async function readNew(file: string, from: { offset: number; partial: string }): Promise<string[]> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await fh.stat();
    if (size <= from.offset) return [];
    const buf = Buffer.alloc(size - from.offset);
    await fh.read(buf, 0, buf.length, from.offset);
    from.offset = size;
    const text = from.partial + buf.toString('utf8');
    const lines = text.split('\n');
    from.partial = lines.pop() ?? '';
    return lines.filter((l) => l.trim());
  } finally {
    await fh.close();
  }
}

const parse = <T>(line: string): T | undefined => {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Apply one of the studio's commands to the run this process plays. */
function apply(run: Run, c: LiveCommand): void {
  switch (c.action) {
    case 'pause':
      return run.pause();
    case 'resume':
      return run.resume();
    case 'step':
      return run.step();
    case 'stop':
      return run.stop('stopped from the studio');
    case 'breakpoints':
      return run.setBreakpoints(c.breakpoints.map(String));
    case 'stepMode':
      return run.setStepMode(c.on === true);
    case 'keepWaiting':
    case 'stopStep':
      run.answerOvertime(c.action === 'stopStep' ? 'stop' : 'wait');
      return;
    case 'approval':
      run.answerApproval({ ...c.answer, by: 'studio' });
      return;
    case 'recovery':
      run.answerRecovery({ ...c.answer, by: 'studio' });
  }
}

/**
 * Publish a run this process plays: its messages as they come, and the studio's commands
 * applied to it. Returns a function that stops publishing.
 */
export async function publishLive(
  run: Run,
  info: { readonly source: string; readonly workspace: string },
  root: string,
): Promise<() => void> {
  void pruneLive(root);
  const dir = join(root, run.id);
  await mkdir(dir, { recursive: true });
  const meta: LiveMeta = {
    id: run.id,
    pattern: run.score.pattern,
    goal: run.score.goal,
    source: info.source,
    workspace: info.workspace,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    score: run.score,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
  const messagesFile = join(dir, 'messages.jsonl');
  // In order, a batch at a time: many small messages (streamed text) must not each be a write.
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = Promise.resolve();
  const flush = () => {
    timer = undefined;
    if (pending.length === 0) return;
    const text = pending.join('');
    pending = [];
    writing = writing.then(() => appendFile(messagesFile, text)).catch(() => undefined);
  };
  const add = (m: RunMessage) => {
    pending.push(`${JSON.stringify(m)}\n`);
    if (m.type === 'status' && TERMINAL.has(m.status)) flush();
    else timer ??= setTimeout(flush, FLUSH_MS);
  };
  for (const m of run.messages) add(m);
  const off = run.subscribe(add);
  const commands = { offset: 0, partial: '' };
  const commandsFile = join(dir, 'commands.jsonl');
  let busy = false;
  const poll = setInterval(() => {
    if (busy) return;
    if (TERMINAL.has(run.status)) {
      clearInterval(poll);
      return;
    }
    busy = true;
    void readNew(commandsFile, commands)
      .then((lines) => {
        for (const line of lines) {
          const c = parse<LiveCommand>(line);
          if (c) apply(run, c);
        }
      })
      .finally(() => {
        busy = false;
      });
  }, POLL_MS);
  poll.unref?.();
  return () => {
    off();
    clearInterval(poll);
    flush();
  };
}

/** Remove the folders of runs older than a week whose process is gone. */
export async function pruneLive(root: string, now = Date.now()): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const dir = join(root, name);
      const st = await stat(dir).catch(() => undefined);
      if (!st || now - st.mtimeMs < KEEP_MS) return;
      const meta = parse<LiveMeta>(await readFile(join(dir, 'meta.json'), 'utf8').catch(() => ''));
      if (meta && alive(meta.pid)) return;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

/** A run another process plays, as the studio sees it: read from its folder, steered by commands. */
export class LiveRun implements RunLike {
  readonly id: string;
  readonly score: ExecutableScore;
  readonly source: string;
  readonly workspace: string;
  readonly startedAt: string;
  readonly messages: RunMessage[] = [];
  status: RunStatus = 'running';
  private polling: Promise<void> | undefined;
  private readonly listeners = new Set<(m: RunMessage) => void>();
  private readonly read = { offset: 0, partial: '' };
  private readonly dir: string;
  private readonly pid: number;

  constructor(dir: string, meta: LiveMeta) {
    this.dir = dir;
    this.id = meta.id;
    this.score = meta.score;
    this.source = meta.source;
    this.workspace = meta.workspace;
    this.startedAt = meta.startedAt;
    this.pid = meta.pid;
  }

  get ended(): boolean {
    return TERMINAL.has(this.status);
  }

  /** Read what the playing process wrote since the last time (one read at a time). */
  poll(): Promise<void> {
    this.polling ??= this.readMore().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async readMore(): Promise<void> {
    for (const line of await readNew(join(this.dir, 'messages.jsonl'), this.read)) {
      const m = parse<RunMessage>(line);
      if (m) this.push(m);
    }
    // The process that played it is gone (VS Code closed) before the run ended.
    if (!this.ended && !alive(this.pid)) {
      this.push({
        seq: (this.messages.at(-1)?.seq ?? -1) + 1,
        type: 'status',
        status: 'cancelled',
        reason: 'the session that played it ended',
      });
    }
  }

  private push(m: RunMessage): void {
    this.messages.push(m);
    if (m.type === 'status') this.status = m.status;
    for (const l of this.listeners) l(m);
  }

  subscribe(listener: (m: RunMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(c: LiveCommand): string | undefined {
    if (this.ended) return 'the run has ended';
    void appendFile(join(this.dir, 'commands.jsonl'), `${JSON.stringify(c)}\n`).catch(
      () => undefined,
    );
    return undefined;
  }

  pause(): void {
    this.send({ action: 'pause' });
  }
  resume(): void {
    this.send({ action: 'resume' });
  }
  step(): void {
    this.send({ action: 'step' });
  }
  stop(): void {
    this.send({ action: 'stop' });
  }
  setBreakpoints(ids: readonly string[]): void {
    this.send({ action: 'breakpoints', breakpoints: [...ids] });
  }
  setStepMode(on: boolean): void {
    this.send({ action: 'stepMode', on });
  }
  answerOvertime(action: 'wait' | 'stop'): string | undefined {
    return this.send({ action: action === 'stop' ? 'stopStep' : 'keepWaiting' });
  }
  answerApproval(answer: HumanAnswer): string | undefined {
    return this.send({ action: 'approval', answer });
  }
  answerRecovery(answer: RecoveryAnswer): string | undefined {
    return this.send({ action: 'recovery', answer });
  }
}

/** Every run other processes publish, for the studio: listed, read and followed live. */
export class LiveRuns {
  private readonly runs = new Map<string, LiveRun>();
  private readonly root: string;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(root: string) {
    this.root = root;
  }

  /** Runs whose folder changed in the last day, newest first; each read up to now. */
  async list(now = Date.now()): Promise<LiveRun[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const found = await Promise.all(
      names.map(async (name) => {
        const known = this.runs.get(name);
        if (known) return known;
        const dir = join(this.root, name);
        const st = await stat(dir).catch(() => undefined);
        if (!st || now - st.mtimeMs > LIST_MS) return undefined;
        const meta = parse<LiveMeta>(
          await readFile(join(dir, 'meta.json'), 'utf8').catch(() => ''),
        );
        if (!meta?.score) return undefined;
        const run = new LiveRun(dir, meta);
        this.runs.set(run.id, run);
        return run;
      }),
    );
    const runs = found.filter((r): r is LiveRun => r !== undefined);
    await Promise.all(runs.filter((r) => !r.ended).map((r) => r.poll()));
    this.follow();
    return runs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async get(id: string): Promise<LiveRun | undefined> {
    if (!this.runs.has(id)) await this.list();
    return this.runs.get(id);
  }

  /** Keep reading the runs still playing, so a stream gets their messages as they come. */
  private follow(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const playing = [...this.runs.values()].filter((r) => !r.ended);
      if (playing.length === 0) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      for (const r of playing) void r.poll();
    }, POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
