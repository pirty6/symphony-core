/** How preloaded files appear in a prompt: no I/O here, so the studio can build prompts too. */

export interface PreloadedFile {
  readonly path: string;
  /** The file with line numbers ("12| text"), or why it is not here. */
  readonly text: string;
  readonly lines: number;
  /** Lines left out for size (read them with tools), if any: [from, to]. */
  readonly omitted?: readonly [number, number];
}

/** The prompt section for preloaded files. */
export function preloadSection(field: string, files: readonly PreloadedFile[]): string[] {
  if (files.length === 0) return [];
  return [
    '',
    `## Files of \`${field}\`, read in full by the engine`,
    `Each workspace file of \`${field}\` is below, whole, with line numbers ("12| text"). Read it here and do not open it again with tools: use tools only to follow references out of it (imports, callers, tests, config, history) and for items not shown here (URLs). Quote the text after "N| " when you cite a line.`,
    ...files.flatMap((f) => [
      '',
      `=== ${f.path} (${f.lines} lines)${f.omitted ? ` — lines ${f.omitted[0]}-${f.omitted[1]} left out for size: read them with tools` : ''} ===`,
      f.text,
    ]),
  ];
}
