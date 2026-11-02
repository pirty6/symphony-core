/**
 * Items of a preloaded list (AgentNode.preload): a workspace file, a line range of one the
 * engine queued (a chunk), or a URL the step fetches itself. Shared by the runtime that reads
 * them and the engine that checks its record of what was given. Pure.
 */

/** A chunk the engine queues for the rest of a file too long for one prompt. */
const CHUNK = /#chunk=(\d+)-(\d+)$/;

export const isUrl = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim());

/** "path#chunk=from-to": these lines of the file, read on their own. */
export const chunkItem = (path: string, from: number, to: number): string =>
  `${path}#chunk=${from}-${to}`;

/**
 * The file an item names and, for a chunk, its lines. "src/a.ts#L10-40" or "src/a.ts:10"
 * (a citation) name the whole file.
 */
export function itemOf(raw: string): {
  readonly path: string;
  readonly from?: number;
  readonly to?: number;
} {
  const item = raw.trim();
  const chunk = CHUNK.exec(item);
  if (chunk) {
    const from = Number(chunk[1]);
    const to = Number(chunk[2]);
    if (from >= 1 && to >= from) return { path: item.slice(0, chunk.index), from, to };
  }
  return { path: item.replace(/(#L?\d.*|:\d+(-\d+)?)$/, '') };
}
