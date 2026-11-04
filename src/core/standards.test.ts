import { describe, expect, it } from 'vitest';
import { codeStandardFor, codeStandardSection, CLEAN_CODE_RULES } from './standards.js';
import type { AgentNode } from './types.js';

const node = (over: Partial<AgentNode>): AgentNode => ({
  id: 'n',
  kind: 'agent',
  role: 'assessor',
  label: 'n',
  directive: 'd',
  reads: [],
  writes: [],
  ...over,
});

describe('codeStandardFor', () => {
  it('holds executors with workspace tools to the standard as writers', () => {
    expect(codeStandardFor(node({ role: 'executor' }))).toBe('write');
  });

  it('leaves isolated executors and plain assessors alone', () => {
    expect(codeStandardFor(node({ role: 'executor', isolated: true }))).toBeUndefined();
    expect(codeStandardFor(node({}))).toBeUndefined();
  });

  it('makes a reviewsCode step a reviewer, whatever its role', () => {
    expect(codeStandardFor(node({ reviewsCode: true }))).toBe('review');
    expect(codeStandardFor(node({ role: 'executor', reviewsCode: true }))).toBe('review');
  });
});

describe('codeStandardSection', () => {
  it('lists every rule under one heading', () => {
    const lines = codeStandardSection('write');
    expect(lines[0]).toBe('## Code standard: Clean Code (Robert C. Martin)');
    expect(lines.slice(2)).toEqual(CLEAN_CODE_RULES.map((r) => `- ${r}`));
  });
});
