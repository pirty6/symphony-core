import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stateDir, symphonyHome } from './state.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'symphony-state-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a workspace's Symphony files live outside it", () => {
  it('under ~/.symphony/workspaces, one folder per workspace path', () => {
    const home = join(tmp(), 'home');
    const env = { SYMPHONY_HOME: home, SYMPHONY_STATE: 'home' };
    const a = join(tmp(), 'app');
    const b = join(tmp(), 'app');
    mkdirSync(a);
    mkdirSync(b);
    const da = stateDir(a, env);
    expect(da.startsWith(join(home, 'workspaces', 'app-'))).toBe(true);
    // Same folder name, another path: another folder; the same path: the same one.
    expect(stateDir(b, env)).not.toBe(da);
    expect(stateDir(a, env)).toBe(da);
    expect(symphonyHome({ SYMPHONY_HOME: '' })).toMatch(/[.]symphony$/);
  });

  it('SYMPHONY_STATE=workspace keeps the old layout, inside the workspace', () => {
    const ws = tmp();
    expect(stateDir(ws, { SYMPHONY_STATE: 'workspace' })).toBe(join(ws, '.symphony'));
  });

  it("moves a workspace's old .symphony folder out, saved runs and memory with it", () => {
    const ws = tmp();
    const env = { SYMPHONY_HOME: join(tmp(), 'home'), SYMPHONY_STATE: 'home' };
    const later = Date.now() + 16 * 60_000;
    mkdirSync(join(ws, '.symphony', 'runs'), { recursive: true });
    writeFileSync(join(ws, '.symphony', 'runs', 'r.json'), '{"n":1}');
    writeFileSync(join(ws, '.symphony', 'memory.json'), '{"facts":[]}');
    // Only looking moves nothing; nor does anything while a run may still be writing there.
    expect(stateDir(ws, env, { move: false })).toBe(join(ws, '.symphony'));
    expect(stateDir(ws, env, { now: Date.now() })).toBe(join(ws, '.symphony'));
    expect(existsSync(join(ws, '.symphony'))).toBe(true);
    // A quarter of an hour later it moves.
    const dir = stateDir(ws, env, { now: later });
    expect(existsSync(join(ws, '.symphony'))).toBe(false);
    expect(readFileSync(join(dir, 'runs', 'r.json'), 'utf8')).toBe('{"n":1}');
    expect(readFileSync(join(dir, 'memory.json'), 'utf8')).toBe('{"facts":[]}');
    // An older process wrote there again: merged in once idle; a file in both stays where it is.
    mkdirSync(join(ws, '.symphony', 'runs'), { recursive: true });
    writeFileSync(join(ws, '.symphony', 'runs', 'late.json'), '{"n":2}');
    writeFileSync(join(ws, '.symphony', 'memory.json'), '{"facts":["old"]}');
    expect(stateDir(ws, env, { now: later })).toBe(dir);
    expect(readFileSync(join(dir, 'runs', 'late.json'), 'utf8')).toBe('{"n":2}');
    expect(readFileSync(join(dir, 'memory.json'), 'utf8')).toBe('{"facts":[]}');
    expect(existsSync(join(ws, '.symphony', 'runs'))).toBe(false);
    expect(existsSync(join(ws, '.symphony', 'memory.json'))).toBe(true);
  });

  it('gives one answer per workspace for the life of the process, so a run never splits its files', () => {
    const ws = tmp();
    const env = { SYMPHONY_HOME: join(tmp(), 'home'), SYMPHONY_STATE: 'home' };
    mkdirSync(join(ws, '.symphony'));
    writeFileSync(join(ws, '.symphony', 'memory.json'), '{}');
    // Just written: the old folder, and it stays the answer here even once it is idle.
    const first = stateDir(ws, env);
    expect(first).toBe(join(ws, '.symphony'));
    expect(stateDir(ws, env)).toBe(first);
  });

  it.runIf(process.platform === 'darwin')(
    'a path typed in another case is the same workspace',
    () => {
      const ws = tmp();
      const env = { SYMPHONY_HOME: join(tmp(), 'home'), SYMPHONY_STATE: 'home' };
      expect(stateDir(ws.toUpperCase(), env, { move: false })).toBe(
        stateDir(ws, env, { move: false }),
      );
    },
  );
});
