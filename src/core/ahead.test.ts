import { describe, expect, it } from 'vitest';
import { compileScore } from './compile.js';
import { advance, createEngine, toPerformance, type AdvanceResult } from './engine.js';
import { replayPerformance } from './replay.js';
import type { AgentPause, AiTranscript, ExecutableScore, Pattern } from './types.js';
import { validatePattern } from './validate.js';

const verdict = { outcome: 'applied', confidence: 0.9, shouldTerminate: false, reason: 'ok' };
const ok = (updates: Record<string, unknown>) => ({ updates, verdict });
const SEARCHED: AiTranscript = { provider: 'p', prompt: 'search', output: 'found', toolCalls: [] };
const FOUND = ok({ found: ['F1 web: the timeout is 5000'] });
const NOTHING = ok({ found: [] });

/**
 * read (agent) plays search ahead with its batch set; pick sets that batch for real; search
 * (agent) must find something. read may also change the sources pick takes the batch from.
 */
const pattern: Pattern = {
  name: 'ahead',
  description: 'd',
  requiredContext: [],
  state: [
    { name: 'aheadOn', type: 'boolean', initial: true },
    { name: 'sources', type: 'string[]', initial: ['web', 'git'] },
    { name: 'notes', type: 'string[]' },
    { name: 'batch', type: 'string[]' },
    { name: 'found', type: 'string[]' },
  ],
  start: 's',
  nodes: [
    { id: 's', kind: 'start', label: 'S' },
    {
      id: 'read',
      kind: 'agent',
      role: 'assessor',
      label: 'Read',
      directive: 'read',
      reads: ['sources'],
      writes: ['notes', 'sources'],
      ahead: {
        node: 'search',
        when: 'aheadOn',
        input: [{ field: 'batch', expr: 'take(sources, 1)' }],
        same: ['batch'],
      },
    },
    {
      id: 'pick',
      kind: 'compute',
      label: 'Pick',
      assign: [{ field: 'batch', expr: 'take(sources, 1)' }],
    },
    {
      id: 'search',
      kind: 'agent',
      role: 'assessor',
      label: 'Search',
      directive: 'search',
      reads: ['batch', 'notes'],
      writes: ['found'],
      checks: [{ expr: 'len(found) > 0', message: 'Report what you found.' }],
    },
    { id: 'e', kind: 'end', label: 'E' },
  ],
  edges: [
    { id: 'a', from: 's', to: 'read' },
    { id: 'b', from: 'read', to: 'pick' },
    { id: 'c', from: 'pick', to: 'search' },
    { id: 'd', from: 'search', to: 'e' },
  ],
};

const scoreWith = (context: Record<string, unknown> = {}): ExecutableScore =>
  compileScore(pattern, { goal: 'g', context, generatedAt: 't' });

/** read answers with these sources, and the search played ahead answers `searched`. */
function readWithAhead(s: ExecutableScore, sources: string[], searched: unknown): AdvanceResult {
  const r = createEngine(s, { startedAt: 't' });
  return advance(s, r.state, {
    kind: 'agent',
    pauseId: r.state.pause!.pauseId,
    result: ok({ notes: ['n'], sources }),
    ahead: { result: searched, transcript: SEARCHED, at: 't1' },
    at: 't2',
  });
}

const stepAt = (r: AdvanceResult, nodeId: string) =>
  r.state.steps.find((step) => step.nodeId === nodeId)!;

describe('a step played ahead', () => {
  it("is paused with the step's own pause, its input set as the steps before it would", () => {
    const r = createEngine(scoreWith(), { startedAt: 't' });
    const ahead = (r.state.pause as AgentPause).ahead!;
    expect([ahead.nodeId, ahead.input.batch]).toEqual(['search', ['web']]);
  });

  it('is not played when its guard does not hold', () => {
    const r = createEngine(scoreWith({ aheadOn: false }), { startedAt: 't' });
    expect((r.state.pause as AgentPause).ahead).toBeUndefined();
  });

  it('answers its step when the run reaches it, without a pause there', () => {
    const r = readWithAhead(scoreWith(), ['web', 'git'], FOUND);
    expect([r.state.outcome, r.state.state.found]).toEqual(['success', FOUND.updates.found]);
  });

  it('is recorded once: with the step that played it, and referenced by the step it answered', () => {
    const r = readWithAhead(scoreWith(), ['web', 'git'], FOUND);
    expect(stepAt(r, 'read').ahead).toMatchObject({ nodeId: 'search', transcript: SEARCHED });
    expect(stepAt(r, 'search')).toMatchObject({ aheadFrom: stepAt(r, 'read').step });
    expect(stepAt(r, 'search').transcript).toBeUndefined();
  });

  it('is dropped when a field it depended on changed, naming the field; the step then plays', () => {
    const r = readWithAhead(scoreWith(), ['git'], FOUND);
    expect(r.state.events).toContainEqual({
      type: 'ahead-dropped',
      nodeId: 'search',
      changed: ['batch'],
    });
    expect(r.state.pause).toMatchObject({ nodeId: 'search', attempt: 1 });
  });

  it("is sent back like any answer that fails the step's checks, and the step plays again", () => {
    const r = readWithAhead(scoreWith(), ['web', 'git'], NOTHING);
    expect(r.state.pause).toMatchObject({ nodeId: 'search', attempt: 2 });
    expect(r.state.attempts).toEqual([
      expect.objectContaining({
        ahead: true,
        errors: ['Report what you found. (check failed: len(found) > 0)'],
      }),
    ]);
  });

  it('replays exactly when it answered its step', () => {
    const s = scoreWith();
    const r = readWithAhead(s, ['web', 'git'], FOUND);
    expect(replayPerformance(s, toPerformance(r.state)).divergence.reproduced).toBe(true);
  });

  it('replays exactly when it was sent back and the step answered again', () => {
    const s = scoreWith();
    const sentBack = readWithAhead(s, ['web', 'git'], NOTHING);
    const r = advance(s, sentBack.state, {
      kind: 'agent',
      pauseId: sentBack.state.pause!.pauseId,
      result: FOUND,
      at: 't3',
    });
    expect(replayPerformance(s, toPerformance(r.state)).divergence.reproduced).toBe(true);
  });
});

describe('validating a step played ahead', () => {
  const withAhead = (ahead: unknown): Pattern => ({
    ...pattern,
    nodes: pattern.nodes.map((n) => (n.id === 'read' ? { ...n, ahead } : n)) as Pattern['nodes'],
  });

  it('accepts the pattern above', () => {
    expect(validatePattern(pattern).errors).toEqual([]);
  });

  it('refuses a step that is not another agent step', () => {
    const p = withAhead({ node: 'pick', when: 'aheadOn', same: ['batch'] });
    expect(validatePattern(p).errors).toContainEqual(
      expect.objectContaining({ message: "ahead.node 'pick' must be another agent step" }),
    );
  });

  it('refuses depending on a field the step does not read', () => {
    const p = withAhead({ node: 'search', when: 'aheadOn', same: ['sources'] });
    expect(validatePattern(p).errors).toContainEqual(
      expect.objectContaining({
        message: "ahead.same must list fields 'search' reads (not: sources)",
      }),
    );
  });
});
