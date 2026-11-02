/**
 * Files read whole by the runtime for a step that lists them (AgentNode.preload), so
 * the AI reads them in one turn instead of paging through them with tool calls.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isUrl, itemOf } from '../core/items.js';
import type { PreloadedFile } from './preload-prompt.js';

export type { PreloadedFile } from './preload-prompt.js';

/** One file may fill at most this much of a prompt; the rest is left to tools. */
export const MAX_FILE_CHARS = 120_000;
/** All files of one call together. */
export const MAX_CALL_CHARS = 360_000;

/** Read the workspace files among `paths` (URLs and anything outside are skipped). */
export async function preloadFiles(
  workspace: string,
  paths: readonly unknown[],
): Promise<PreloadedFile[]> {
  const out: PreloadedFile[] = [];
  const seen = new Set<string>();
  let budget = MAX_CALL_CHARS;
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim() || isUrl(p)) continue;
    // A citation-like item names the whole file, given once; a chunk is its own lines.
    const { path, from, to } = itemOf(p);
    const item = from === undefined ? path : p.trim();
    if (seen.has(item)) continue;
    seen.add(item);
    const full = resolve(workspace, path);
    // Said, not dropped: the AI reads what the engine could not.
    const failed = (error: string) => out.push({ path, item, text: `(${error})`, lines: 0, error });
    if (isAbsolute(path) || relative(workspace, full).startsWith('..')) {
      failed('outside the workspace');
      continue;
    }
    const raw = await readFile(full).catch((e: NodeJS.ErrnoException) =>
      e.code === 'ENOENT' ? 'not found in the workspace' : `read failed: ${e.code ?? e.message}`,
    );
    if (typeof raw === 'string') {
      failed(raw);
      continue;
    }
    if (raw.includes(0)) {
      failed('binary file');
      continue;
    }
    const all = raw.toString('utf8').split('\n');
    // The lines asked for: all of them, or a chunk's.
    const first = Math.min(from ?? 1, all.length);
    const last = Math.min(to ?? all.length, all.length);
    const cap = Math.min(MAX_FILE_CHARS, budget);
    let used = 0;
    let shown = first - 1;
    const numbered: string[] = [];
    for (let i = first - 1; i < last; i++) {
      const row = `${i + 1}| ${all[i]}`;
      if (used + row.length + 1 > cap) break;
      numbered.push(row);
      used += row.length + 1;
      shown = i + 1;
    }
    budget -= used;
    out.push({
      path,
      item,
      text: numbered.join('\n'),
      lines: all.length,
      ...(from !== undefined ? { range: [first, last] as const } : {}),
      ...(shown < last
        ? {
            omitted: [shown + 1, last] as const,
            cut: MAX_FILE_CHARS <= cap ? ('file' as const) : ('call' as const),
          }
        : {}),
    });
  }
  return out;
}
