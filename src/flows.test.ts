import { describe, expect, it } from 'vitest';
import { FLOW_DOCS, flowBlock, flowchart, readDoc, updateFlows } from './flows.js';
import { findPattern } from './patterns/index.js';

describe('docs flow diagrams', () => {
  it.each(FLOW_DOCS)('%s is up to date with the patterns (run npm run docs)', (file) => {
    const doc = readDoc(file);
    expect(updateFlows(doc)).toBe(doc);
  });

  it('every documented algorithm has a generated flow', () => {
    const doc = FLOW_DOCS.map((f) => readDoc(f)).join('\n');
    for (const name of [
      'investigate',
      'fix',
      'refactor',
      'implement',
      'backlog',
      'review',
      'analyze',
      'maestro',
    ])
      expect(doc).toContain(`<!-- flow:${name} -->\n<!-- Generated`);
  });

  it('draws phases as one box and loops as dashed arrows, with mermaid-safe ids', () => {
    const chart = flowchart(findPattern('refactor')!);
    expect(chart).toMatch(/n_baselinePhase\[\["Green baseline · 3 steps"\]\]/);
    expect(chart).toMatch(/n_prReviewPhase -\.-> n_editPhase/);
    // "end" is a mermaid keyword: every id is prefixed.
    expect(chart).not.toMatch(/^\s+end\b/m);
  });

  it('a block names a real pattern', () => {
    expect(() => flowBlock('nope')).toThrow(/no pattern 'nope'/);
  });
});
