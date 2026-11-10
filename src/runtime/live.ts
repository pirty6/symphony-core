/**
 * Runs shared between processes on this machine, so a run a VS Code chat started (through the
 * MCP server) shows in the studio, live, and can be steered from there. Each run is a folder
 * under ~/.symphony/live/<run id> (SYMPHONY_LIVE_DIR moves it; SYMPHONY_LIVE=off turns it off):
 *
 * - meta.json: what the run is (its score) and which process plays it;
 * - messages.jsonl: every message of the run, in order, as the studio streams them;
 * - commands.jsonl: what the studio asks (approve, pause, stop…), applied by the playing process;
 * - resume.json: how another process can pick the run up if this one ends mid-run (a chat's MCP
 *   server is restarted, e.g. when the chat changes model): its saved file, and the run that
 *   continued it (a hand-off, or this run resumed elsewhere).
 *
 * The process that plays the run stays its only owner: the studio never runs it, it only reads
 * and asks.
 */
import { scrubbingOn, scrubValue, StreamScrubber } from '../core/scrub.js';
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChainStep } from '../core/chain.js';
import type { ExecutableScore } from '../core/types.js';
import type { HumanAnswer, RecoveryAnswer, Run, RunMessage, RunStatus } from './driver.js';

type ProviderMessage = Extract<RunMessage, { type: 'provider' }>;

/** One AI session's key: its streams are scrubbed apart from other sessions' (parts, takes). */
const session = (m: ProviderMessage) => `${m.nodeId}|${m.attempt}|${m.take ?? ''}|`;

/**
 * A run's messages as they may leave the process (the live file, the studio's stream): streamed
 * text is scrubbed across its pieces (a piece may be held back until its stream ends, so the
 * caller numbers what comes out), everything else whole. Pass-through with SYMPHONY_SCRUB=off.
 */
export function scrubbedFeed(emit: (m: RunMessage) => void): (m: RunMessage) => void {
  if (!scrubbingOn()) return emit;
  const streams = new Map<string, { scrubber: StreamScrubber; like: ProviderMessage }>();
  /** End the streams whose key starts with `prefix` ('' for all): what they held goes out. */
  const endStreams = (prefix: string) => {
    for (const [key, { scrubber, like }] of streams) {
      if (!key.startsWith(prefix)) continue;
      const text = scrubber.end();
      if (text && (like.event.type === 'delta' || like.event.type === 'reasoning'))
        emit({ ...like, event: { ...like.event, text } });
      streams.delete(key);
    }
  };
  return (m) => {
    if (m.type === 'provider' && (m.event.type === 'delta' || m.event.type === 'reasoning')) {
      const key = `${session(m)}${m.event.type}`;
      const scrubber = streams.get(key)?.scrubber ?? new StreamScrubber();
      streams.set(key, { scrubber, like: m });
      const text = scrubber.push(m.event.text);
      if (text) emit({ ...m, event: { ...m.event, text } });
      return;
    }
    // The same session saying something else, its step moving on, or the run ending: the
    // streams that are over go out first, in order. Other sessions' streams keep going.
    if (m.type === 'provider') endStreams(session(m));
    else if (m.type === 'engine' && 'nodeId' in m.event) endStreams(`${m.event.nodeId}|`);
    else if (m.type === 'performance' || (m.type === 'status' && TERMINAL.has(m.status)))
      endStreams('');
    emit(scrubValue(m));
  };
}

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
  | 'setAutoApprove'
  | 'answerOvertime'
  | 'answerRecovery'
  | 'answerApproval'
> & {
  /** Load what the run said so far for a viewer; the function it gives back lets go of it. */
  readonly open?: () => Promise<() => void>;
};

export interface LiveMeta {
  readonly id: string;
  readonly pattern: string;
  readonly goal: string;
  /** Who plays it: 'chat' (the MCP server, e.g. a VS Code chat) or 'cli' (the symphony CLI). */
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
  | { readonly action: 'autoApprove'; readonly on: boolean }
  | { readonly action: 'approval'; readonly answer: HumanAnswer }
  | { readonly action: 'recovery'; readonly answer: RecoveryAnswer };

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled']);
const POLL_MS = 400;
const FLUSH_MS = 100;
/** Older runs' folders are removed when a new run is published. */
const KEEP_MS = 7 * 24 * 3600_000;
/** The studio lists runs whose folder changed within this. */
const LIST_MS = 24 * 3600_000;
/** A run's last status, written by the process that plays it. */
const STATUS_FILE = 'status.json';
/** Without a status file (an older publisher), its last status is looked for in this much of the end. */
const TAIL_BYTES = 64 * 1024;

/** The last status a run's messages give, read from the end of the file only. */
async function lastStatus(file: string): Promise<RunStatus | undefined> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n').toReversed();
    for (const line of lines) {
      if (!line.includes('"status"')) continue;
      const m = parse<RunMessage>(line);
      if (m?.type === 'status') return m.status;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

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

/** What another process needs to pick a run up: written by the process that plays it. */
export interface LiveResume {
  readonly savedTo?: string;
  /** The run that continued this one: its hand-off, or this run resumed by another process. */
  readonly next?: string;
  readonly provider?: string;
  readonly autoApprove?: boolean;
  readonly chain?: readonly ChainStep[];
}

export interface LiveEntry {
  readonly meta: LiveMeta;
  readonly status?: RunStatus;
  readonly resume: LiveResume;
  /** Its process is still running. */
  readonly playing: boolean;
}

const RESUME_FILE = 'resume.json';
const CLAIM_FILE = 'claim';
/** Run ids as Run makes them: never a path. */
const RUN_ID = /^run-[a-z0-9]+-[a-z0-9]+$/;
const noting = new Map<string, Promise<void>>();

/** Add to a run's resume.json; one write at a time per run. */
export function noteLive(root: string, id: string, patch: LiveResume): Promise<void> {
  const file = join(root, id, RESUME_FILE);
  const done = (noting.get(file) ?? Promise.resolve())
    .then(async () => {
      const now = parse<LiveResume>(await readFile(file, 'utf8').catch(() => '')) ?? {};
      await writeFile(file, JSON.stringify({ ...now, ...patch }));
    })
    .catch(() => undefined);
  noting.set(file, done);
  return done;
}

/** A published run as another process sees it; undefined when there is none by that id. */
export async function readLiveEntry(root: string, id: string): Promise<LiveEntry | undefined> {
  if (!RUN_ID.test(id)) return undefined;
  const dir = join(root, id);
  const meta = parse<LiveMeta>(await readFile(join(dir, 'meta.json'), 'utf8').catch(() => ''));
  if (!meta) return undefined;
  const status = parse<{ status?: RunStatus }>(
    await readFile(join(dir, STATUS_FILE), 'utf8').catch(() => ''),
  )?.status;
  const resume = parse<LiveResume>(await readFile(join(dir, RESUME_FILE), 'utf8').catch(() => ''));
  return {
    meta,
    ...(status ? { status } : {}),
    resume: resume ?? {},
    playing: alive(meta.pid),
  };
}

/** Take a run whose process ended, to resume it: false when another live process has it. */
export async function claimLive(root: string, id: string): Promise<boolean> {
  const file = join(root, id, CLAIM_FILE);
  const mine = String(process.pid);
  try {
    await writeFile(file, mine, { flag: 'wx' });
    return true;
  } catch {
    const holder = Number(await readFile(file, 'utf8').catch(() => ''));
    if (holder > 0 && holder !== process.pid && alive(holder)) return false;
    await writeFile(file, mine);
    return true;
  }
}

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
    case 'autoApprove':
      return run.setAutoApprove(c.on === true);
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
  const statusFile = join(dir, STATUS_FILE);
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
  // Secrets never reach the file (core/scrub): streamed text is scrubbed across its pieces, and
  // the file numbers what it holds itself, since a piece may be held back until its stream ends.
  let seq = 0;
  const feed = scrubbedFeed((m) => pending.push(`${JSON.stringify({ ...m, seq: seq++ })}\n`));
  const add = (m: RunMessage) => {
    feed(m);
    // The studio lists runs by this small file, never by reading every message.
    if (m.type === 'status')
      writing = writing
        .then(() => writeFile(statusFile, JSON.stringify({ status: m.status })))
        .catch(() => undefined);
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
  /** Viewers that opened it: its messages are in memory only while there are some. */
  private viewers = 0;
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

  get opened(): boolean {
    return this.viewers > 0;
  }

  /**
   * Load its messages for a viewer (a run can be hundreds of MB); the function it gives back lets
   * go, and when the last viewer has, they are freed (read again on the next open).
   */
  async open(): Promise<() => void> {
    this.viewers += 1;
    await this.poll();
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      this.viewers -= 1;
      if (this.viewers === 0) this.release();
    };
  }

  private release(): void {
    this.messages.length = 0;
    this.read.offset = 0;
    this.read.partial = '';
  }

  /** Read what the playing process wrote since the last time (one read at a time). */
  poll(): Promise<void> {
    this.polling ??= (this.opened ? this.readMore() : this.readStatus()).finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  /** Its status alone, from the small file the player writes (or the end of its messages). */
  private async readStatus(): Promise<void> {
    const recorded = parse<{ status?: RunStatus }>(
      await readFile(join(this.dir, STATUS_FILE), 'utf8').catch(() => ''),
    )?.status;
    const status = recorded ?? (await lastStatus(join(this.dir, 'messages.jsonl')));
    if (status) this.status = status;
    if (!this.ended && !alive(this.pid)) this.status = 'cancelled';
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
  setAutoApprove(on: boolean): void {
    this.send({ action: 'autoApprove', on });
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
        const dir = join(this.root, name);
        const st = await stat(dir).catch(() => undefined);
        if (!st || now - st.mtimeMs > LIST_MS) {
          // Out of the list: let go of it unless someone is looking at it.
          if (known && !known.opened) this.runs.delete(name);
          return known?.opened ? known : undefined;
        }
        if (known) return known;
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
      // Only runs someone is watching are read as they play; the rest are listed by status.
      const playing = [...this.runs.values()].filter((r) => !r.ended && r.opened);
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
