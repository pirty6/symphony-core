/**
 * Files read whole by the runtime for a step that lists them (AgentNode.preload), so
 * the AI reads them in one turn instead of paging through them with tool calls.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { PreloadedFile } from './preload-prompt.js';

export type { PreloadedFile } from './preload-prompt.js';

/** One file may fill at most this much of a prompt; the rest is left to tools. */
export const MAX_FILE_CHARS = 120_000;
/** All files of one call together. */
export const MAX_CALL_CHARS = 360_000;

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

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
    // "src/a.ts#L10-40" or "src/a.ts:10" name the file; the whole file is given, once.
    const path = p.trim().replace(/(#L?\d.*|:\d+(-\d+)?)$/, '');
    if (seen.has(path)) continue;
    seen.add(path);
    const full = resolve(workspace, path);
    // Said, not dropped: the AI reads what the engine could not.
    const failed = (error: string) => out.push({ path, text: `(${error})`, lines: 0, error });
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
    const cap = Math.min(MAX_FILE_CHARS, budget);
    let used = 0;
    let shown = 0;
    const numbered: string[] = [];
    for (const [i, line] of all.entries()) {
      const row = `${i + 1}| ${line}`;
      if (used + row.length + 1 > cap) break;
      numbered.push(row);
      used += row.length + 1;
      shown = i + 1;
    }
    budget -= used;
    out.push({
      path,
      text: numbered.join('\n'),
      lines: all.length,
      ...(shown < all.length ? { omitted: [shown + 1, all.length] as const } : {}),
    });
  }
  return out;
}
