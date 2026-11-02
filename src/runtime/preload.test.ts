import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import type { AgentPause, Pattern } from '../core/types.js';
import { replayPerformance } from '../core/replay.js';
import { validatePattern } from '../core/validate.js';
import { defaultTools } from './builtin-tools.js';
import { Run } from './driver.js';
import { MAX_FILE_CHARS, preloadFiles } from './preload.js';
import { preloadSection } from './preload-prompt.js';
import { buildAgentPrompt, type AgentRequest, type Provider } from './provider.js';

const ws = mkdtempSync(join(tmpdir(), 'symphony-preload-'));
afterAll(() => rmSync(ws, { recursive: true, force: true }));
mkdirSync(join(ws, 'src'));
writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
writeFileSync(join(ws, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(2000));
writeFileSync(join(ws, 'bin.dat'), Buffer.from([1, 0, 2]));

describe('preloadFiles', () => {
  it('reads each workspace file whole, with line numbers; leaves URLs alone and says what it could not read', async () => {
    const files = await preloadFiles(ws, [
      'src/a.ts#L2',
      'https://example.com/page',
      '../escape.txt',
      'src/missing.ts',
      'bin.dat',
    ]);
    expect(files.map((f) => f.path)).toEqual([
      'src/a.ts',
      '../escape.txt',
      'src/missing.ts',
      'bin.dat',
    ]);
    expect(files[0]).toEqual({
      path: 'src/a.ts',
      item: 'src/a.ts',
      text: '1| export const a = 1;\n2| export const b = 2;\n3| ',
      lines: 3,
    });
    expect(files.slice(1).map((f) => f.error)).toEqual([
      'outside the workspace',
      'not found in the workspace',
      'binary file',
    ]);
    expect(preloadSection('deepBatch', files).join('\n')).toContain(
      '=== src/missing.ts — could not be read by the engine (not found in the workspace): read it with tools ===',
    );
  });

  it('gives each file once, however often it is listed', async () => {
    expect(
      (await preloadFiles(ws, ['src/a.ts', 'src/a.ts:2', 'src/a.ts#L1-2'])).map((f) => f.path),
    ).toEqual(['src/a.ts']);
  });

  it("reads a chunk as its own range, with the file's line numbers; a chunk is not the whole file", async () => {
    const files = await preloadFiles(ws, [
      'big.txt#chunk=1990-2001',
      'big.txt',
      'big.txt#chunk=1990-2001',
    ]);
    expect(files.map((f) => f.item)).toEqual(['big.txt#chunk=1990-2001', 'big.txt']);
    const [chunk] = files;
    expect(chunk).toMatchObject({ path: 'big.txt', range: [1990, 2001], lines: 2001 });
    expect(chunk!.omitted).toBeUndefined();
    expect(chunk!.text.split('\n')[0]).toBe(`1990| ${'x'.repeat(99)}`);
    expect(chunk!.text.split('\n')).toHaveLength(12);
    expect(preloadSection('deepBatch', [chunk!]).join('\n')).toMatch(
      /big\.txt.*lines 1990-2001 of 2001/,
    );
  });

  it('a file too big for one prompt says which lines were left out', async () => {
    const [big] = await preloadFiles(ws, ['big.txt']);
    expect(big!.text.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(big!.omitted![1]).toBe(2001);
    expect(preloadSection('deepBatch', [big!]).join('\n')).toMatch(
      new RegExp(`lines ${big!.omitted![0]}-2001 left out for size`),
    );
  });
});

const reader: Pattern = {
  name: 'reader',
  description: 'reads given files',
  requiredContext: ['files'],
  state: [
    { name: 'files', type: 'string[]' },
    { name: 'notes', type: 'string[]' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'read',
      kind: 'agent',
      role: 'assessor',
      label: 'Read',
      directive: 'read',
      reads: ['files'],
      writes: ['notes'],
      preload: 'files',
    },
    { id: 'end', kind: 'end', label: 'End', outcome: 'success' },
  ],
  edges: [
    { id: 'a', from: 'start', to: 'read' },
    { id: 'b', from: 'read', to: 'end' },
  ],
};

describe('a step with preload', () => {
  it('gets the files whole in its prompt, in one turn', async () => {
    let prompt = '';
    const provider: Provider = {
      name: 'reader',
      runAgent: async (req: AgentRequest) => {
        prompt = buildAgentPrompt(req.pause, req.files ? { files: req.files } : {});
        return {
          result: {
            updates: { notes: ['ok'] },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          },
          transcript: { provider: 'reader', prompt, output: '', toolCalls: [] },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const score = compileScore(reader, { goal: 'g', context: { files: ['src/a.ts'] } });
    const perf = await new Run({
      score,
      provider,
      tools: defaultTools({ probeGitHub: false, mcp: { includeUser: false } }),
      toolContext: { workspace: ws, repoRoot: ws },
    }).start();
    expect(perf.outcome).toBe('success');
    expect(prompt).toMatch(/## Files of `files`, read in full by the engine/);
    expect(prompt).toContain(
      '=== src/a.ts (3 lines) ===\n1| export const a = 1;\n2| export const b = 2;',
    );
    const step = perf.steps.find((s) => s.nodeId === 'read')!;
    expect((step.input as AgentPause['input']).files).toEqual(['src/a.ts']);
    // The record keeps a manifest of what the prompt held, not the text.
    expect(step.transcript?.preloaded).toEqual([{ path: 'src/a.ts', lines: 3 }]);
  });

  it('a failed read is told to the step, file by file, and recorded', async () => {
    let prompt = '';
    const provider: Provider = {
      name: 'reader',
      runAgent: async (req: AgentRequest) => {
        prompt = buildAgentPrompt(req.pause, req.files ? { files: req.files } : {});
        return {
          result: {
            updates: { notes: ['ok'] },
            verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
          },
          transcript: { provider: 'reader', prompt, output: '', toolCalls: [] },
        };
      },
      draft: () => Promise.reject(new Error('n/a')),
    };
    const tools = new Map(defaultTools({ probeGitHub: false, mcp: { includeUser: false } }));
    tools.set('files.read', {
      name: 'files.read',
      description: 'x',
      outputs: ['files'],
      run: () => Promise.reject(new Error('disk on fire')),
    });
    const score = compileScore(reader, {
      goal: 'g',
      context: { files: ['src/a.ts', 'https://x.dev/p'] },
    });
    const run = new Run({ score, provider, tools, toolContext: { workspace: ws, repoRoot: ws } });
    const perf = await run.start();
    expect(perf.outcome).toBe('success');
    expect(prompt).toContain(
      '=== src/a.ts — could not be read by the engine (read failed: disk on fire): read it with tools ===',
    );
    const step = perf.steps.find((s) => s.nodeId === 'read')!;
    expect(step.transcript?.preloaded).toEqual([
      { path: 'src/a.ts', lines: 0, error: 'read failed: disk on fire' },
    ]);
    const info = run.messages.flatMap((m) =>
      m.type === 'provider' && m.event.type === 'info' ? [m.event.text] : [],
    );
    expect(info.join()).toMatch(/1 could not be read \(src\/a\.ts: read failed: disk on fire\)/);
  });

  it('is validated: the field must be a string[] the step reads', () => {
    const nodes = [...reader.nodes];
    nodes[1] = { ...nodes[1]!, reads: [] } as (typeof nodes)[number];
    const bad: Pattern = { ...reader, nodes };
    expect(validatePattern(bad).errors.map((e) => e.message)).toContain(
      "preload 'files' must be a string[] field it reads",
    );
  });
});

describe('preloadReport: the engine, not the AI, says what was not given whole', () => {
  const quarter = `${'y'.repeat(99)}\n`.repeat(1000);
  for (const n of [1, 2, 3, 4]) writeFileSync(join(ws, `q${n}.txt`), quarter);
  const reporter: Pattern = {
    ...reader,
    state: [
      ...reader.state,
      { name: 'partly', type: 'string[]' },
      { name: 'partlyWhy', type: 'string[]' },
      { name: 'given', type: 'string[]' },
      { name: 'partlyRest', type: 'string[]' },
    ],
    nodes: reader.nodes.map((n) =>
      n.id === 'read'
        ? Object.assign({}, n, {
            preloadReport: {
              paths: 'partly',
              reasons: 'partlyWhy',
              whole: 'given',
              rest: 'partlyRest',
            },
          })
        : n,
    ),
  };
  const provider: Provider = {
    name: 'reader',
    runAgent: async () => ({
      result: {
        // The AI claims it read everything.
        updates: { notes: ['read it all'] },
        verdict: { outcome: 'applied', confidence: 1, shouldTerminate: false, reason: 'r' },
      },
      transcript: { provider: 'reader', prompt: '', output: '', toolCalls: [] },
    }),
    draft: () => Promise.reject(new Error('n/a')),
  };

  it('fills the files cut by size or the call budget, and those it could not read; replay agrees', async () => {
    const score = compileScore(reporter, {
      goal: 'g',
      context: { files: ['src/a.ts', 'big.txt', 'q1.txt', 'q2.txt', 'q3.txt', 'nope.ts'] },
    });
    const perf = await new Run({
      score,
      provider,
      tools: defaultTools({ probeGitHub: false, mcp: { includeUser: false } }),
      toolContext: { workspace: ws, repoRoot: ws },
    }).start();
    expect(perf.outcome).toBe('success');
    const s = perf.finalState;
    expect(s.partly).toEqual(['big.txt', 'q3.txt', 'nope.ts']);
    expect(s.partlyWhy).toEqual([
      expect.stringMatching(
        /^longer than one prompt can hold: lines \d+-2001 are read next, as a range/,
      ),
      expect.stringMatching(/^lines \d+-1001 left out of the prompt for the call's size/),
      'the engine could not read it (not found in the workspace)',
    ]);
    // Only what the record shows was given whole: not the cut ones, not the missing one.
    expect(s.given).toEqual(['src/a.ts', 'q1.txt', 'q2.txt']);
    // A cut file's remaining lines come back as a chunk to read next; a missing one has none.
    expect(s.partlyRest).toEqual([
      expect.stringMatching(/^big\.txt#chunk=\d+-2001$/),
      expect.stringMatching(/^q3\.txt#chunk=\d+-1001$/),
      '',
    ]);
    expect(replayPerformance(score, perf).divergence.reproduced).toBe(true);
  });

  it('is validated: string[] fields the AI may not write, on a step that preloads', () => {
    const bad: Pattern = {
      ...reporter,
      nodes: reporter.nodes.map((n) =>
        n.id === 'read' ? Object.assign({}, n, { writes: ['notes', 'partly'] }) : n,
      ),
    };
    expect(validatePattern(bad).errors.map((e) => e.message)).toContain(
      "preloadReport 'partly' is filled by the engine: the AI may not write it",
    );
  });
});
