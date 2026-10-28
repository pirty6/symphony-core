import type { EditsResult } from './types.js';

/** One line saying where a run's edits went (it played in its own worktree). */
export function describeEdits(e: EditsResult): string {
  const files =
    e.files.length > 3
      ? `${e.files.slice(0, 3).join(', ')} +${e.files.length - 3}`
      : e.files.join(', ');
  switch (e.kind) {
    case 'applied':
      return `edits applied to your workspace: ${files}`;
    case 'patch':
      return `edits kept as a patch (${e.reason ?? 'not applied'}): git apply ${e.patch}  [${files}]`;
    default:
      return e.reason ? `no file edits (${e.reason})` : 'no file edits';
  }
}
