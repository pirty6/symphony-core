import { describe, expect, it } from 'vitest';
import { FLOW_DOCS, flowBlock, flowchart, readDoc, updateFlows } from './flows.js';
import { findPattern } from './patterns/index.js';

/** Where a pattern's generated flow starts in a doc. */
const generatedFlow = (name: string) => `<!-- flow:${name} -->\n<!-- Generated`;

describe('docs flow diagrams', () => {
  it('docs/patterns.md is up to date with the patterns (run npm run docs)', () => {
    const doc = readDoc('docs/patterns.md');
    expect(updateFlows(doc)).toBe(doc);
  });

  it('docs/maestro.md is up to date with the patterns (run npm run docs)', () => {
    const doc = readDoc('docs/maestro.md');
    expect(updateFlows(doc)).toBe(doc);
  });

  it('the flow docs are the two checked above', () => {
    expect(FLOW_DOCS).toEqual(['docs/patterns.md', 'docs/maestro.md']);
  });

  it('every documented algorithm has a generated flow', () => {
    const doc = FLOW_DOCS.map((f) => readDoc(f)).join('\n');
    const documented = [
      'investigate',
      'fix',
      'refactor',
      'implement',
      'backlog',
      'review',
      'analyze',
      'maestro',
    ];
    expect(documented.filter((name) => !doc.includes(generatedFlow(name)))).toEqual([]);
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
