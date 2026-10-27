import { describe, expect, it } from 'vitest';
import type { AgentPause } from '../core/types.js';
import { buildAgentPrompt, decidePermission, extractJson, isReadOnlyCommand } from './provider.js';

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
  capabilities: [],
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

describe('isReadOnlyCommand', () => {
  it.each([
    'cd /repo && git --no-pager diff --stat HEAD~1..HEAD && echo "---" && git --no-pager diff HEAD~1..HEAD',
    'git -C /repo --no-pager log -5 --oneline | head -20',
    'grep -rn "foo; bar" src | wc -l',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'git status --porcelain 2>&1',
    'git branch -a',
    'ls -la && cat package.json | jq .scripts',
  ])('allows %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });

  it.each([
    'rm -rf dist',
    'git commit -m x',
    'git branch new-branch',
    'git -c core.pager=sh diff',
    'git diff --output=patch.txt',
    'git diff --ext-diff',
    'FOO=1 git diff',
    'find . -name x -delete',
    'find . -exec rm {} \\;',
    'sed -i s/a/b/ f.txt',
    'echo $(rm x)',
    'echo `rm x`',
    'sort -o out.txt in.txt',
    'cat a > b',
    'echo hi >> log',
    'npm test',
    'git diff | xargs rm',
    'diff <(ls) >(cat)',
  ])('refuses %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });

  it('lets assessors run git diff even when the CLI marks it as a write', () => {
    const text = 'git --no-pager diff HEAD~1..HEAD';
    expect(
      decidePermission('assessor', {
        kind: 'shell',
        commands: [{ identifier: text, readOnly: false }],
        hasWriteFileRedirection: false,
        fullCommandText: text,
      }).allowed,
    ).toBe(true);
    expect(
      decidePermission('assessor', {
        kind: 'shell',
        commands: [{ identifier: 'rm x', readOnly: false }],
        hasWriteFileRedirection: false,
        fullCommandText: 'rm x',
      }).allowed,
    ).toBe(false);
  });
});
