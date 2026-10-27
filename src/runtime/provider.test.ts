import { describe, expect, it } from 'vitest';
import type { AgentPause } from '../core/types.js';
import { buildAgentPrompt, decidePermission, extractJson } from './provider.js';

const pause: AgentPause = {
  kind: 'agent',
  pauseId: 'p1',
  step: 2,
  nodeId: 'gather',
  role: 'assessor',
  label: 'Gather',
  directive: 'Collect evidence',
  goal: 'Find the bug',
  context: { question: 'why?' },
  input: { question: 'why?', findings: [] },
  outputSchema: [{ name: 'findings', type: 'string[]', description: 'evidence' }],
  attempt: 2,
  maxAttempts: 2,
  feedback: ['updates.findings is required'],
  moveKey: 'm',
};

describe('buildAgentPrompt', () => {
  it('includes goal, directive, input, schema, rules and feedback', () => {
    const p = buildAgentPrompt(pause);
    expect(p).toContain('Find the bug');
    expect(p).toContain('Collect evidence');
    expect(p).toContain('"findings": []');
    expect(p).toContain('findings (string[]): evidence');
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('submit_result');
    expect(p).toContain('attempt 2 of 2');
    expect(p).toContain('- updates.findings is required');
  });

  it('is deterministic', () => {
    expect(buildAgentPrompt(pause)).toBe(buildAgentPrompt(pause));
  });
});

describe('extractJson', () => {
  it('prefers the last fenced block', () => {
    expect(extractJson('a ```json\n{"x":1}\n``` b ```\n{"x":2}\n```')).toEqual({ x: 2 });
  });
  it('falls back to braces in plain text and to undefined', () => {
    expect(extractJson('result: {"ok": true} done')).toEqual({ ok: true });
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{broken')).toBeUndefined();
  });
});

describe('decidePermission', () => {
  it('lets executors do anything', () => {
    expect(decidePermission('executor', { kind: 'write' }).allowed).toBe(true);
  });

  it('keeps assessors read-only', () => {
    expect(decidePermission('assessor', { kind: 'read' }).allowed).toBe(true);
    expect(decidePermission('assessor', { kind: 'url' }).allowed).toBe(true);
    expect(decidePermission('assessor', { kind: 'write' }).allowed).toBe(false);
    expect(decidePermission('assessor', { kind: 'memory' }).allowed).toBe(false);
    expect(decidePermission('assessor', { kind: 'mcp' }).allowed).toBe(false);
  });

  it('allows read-only shell and refuses mutating shell for assessors', () => {
    const ro = {
      kind: 'shell',
      commands: [{ identifier: 'git', readOnly: true }],
      hasWriteFileRedirection: false,
    };
    expect(decidePermission('assessor', ro).allowed).toBe(true);
    expect(decidePermission('assessor', { ...ro, hasWriteFileRedirection: true }).allowed).toBe(
      false,
    );
    const rm = decidePermission('assessor', {
      kind: 'shell',
      commands: [{ identifier: 'rm', readOnly: false }],
    });
    expect(rm).toEqual({ allowed: false, reason: 'assessor is read-only; refused: rm' });
    expect(decidePermission('assessor', { kind: 'shell', commands: [] }).allowed).toBe(false);
  });
});
