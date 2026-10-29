import { describe, expect, it } from 'vitest';
import { describeEdits } from './edits.js';

describe('describeEdits', () => {
  it('says where the edits went', () => {
    expect(describeEdits({ kind: 'applied', files: ['a', 'b', 'c', 'd', 'e'] })).toBe(
      'edits applied to your workspace: a, b, c +2',
    );
    expect(
      describeEdits({
        kind: 'patch',
        files: ['a'],
        patch: '/w/x.patch',
        reason: 'the run ended failed',
      }),
    ).toBe('edits kept as a patch (the run ended failed): git apply /w/x.patch  [a]');
    expect(describeEdits({ kind: 'unchanged', files: [] })).toBe('no file edits');
  });
});
