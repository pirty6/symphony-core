import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compileScore } from '../core/compile.js';
import { maestro } from '../patterns/index.js';
import { defaultTools } from './builtin-tools.js';
import { Run } from './driver.js';
import { memoryPath } from './memory.js';
import { ScriptedProvider } from './scripted-provider.js';

const workspace = mkdtempSync(join(tmpdir(), 'symphony-maestro-memory-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

// The demo's canned recall and remember are dropped, so the real memory tools play.
const { recall: _r, remember: _m, ...cannedTools } = maestro.demo!.tools!;
const demo = { ...maestro.demo!, tools: cannedTools };

async function compose(request: string) {
  const run = new Run({
    score: compileScore(maestro, { goal: request, context: { request } }),
    provider: ScriptedProvider.forPattern(maestro),
    demo,
    autoApprove: true,
    tools: defaultTools({ probeGitHub: false, mcp: { includeUser: false } }),
    toolContext: { workspace, repoRoot: workspace },
  });
  const perf = await run.start();
  return { perf, ran: perf.steps.map((s) => s.nodeId) };
}

describe('the maestro remembers what you approved', () => {
  it('composes a request once, then reuses it without classifying or debating', async () => {
    const first = await compose('Fix the flaky login test that fails on CI');
    expect(first.perf.outcome).toBe('success');
    expect(first.ran).toEqual(expect.arrayContaining(['classify', 'propose', 'remember']));
    const memory = JSON.parse(readFileSync(memoryPath(workspace), 'utf8'));
    expect(memory.compositions).toEqual([
      expect.objectContaining({
        request: 'Fix the flaky login test that fails on CI',
        chosen: 'fix',
      }),
    ]);

    const again = await compose('fix the flaky login test that fails on CI ');
    expect(again.perf.outcome).toBe('success');
    expect(again.ran).toContain('reuse');
    expect(again.ran).not.toContain('classify');
    expect(again.ran).not.toContain('propose');
    expect(again.perf.finalState.finalPattern).toEqual(first.perf.finalState.finalPattern);

    // A similar request still composes, with the approved one (re-approved just now) as precedent.
    const similar = await compose('Fix the flaky signup test that fails on CI');
    expect(similar.ran).toContain('classify');
    const classify = similar.perf.steps.find((s) => s.nodeId === 'classify')!;
    expect(classify.input!.pastCompositions).toEqual([
      expect.stringMatching(
        /"fix the flaky login test that fails on CI ?" → fix \(complexity 3\); adaptation/i,
      ),
    ]);
  });
});
