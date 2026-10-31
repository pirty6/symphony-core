/**
 * Flow diagrams for the docs, drawn from the patterns themselves so they cannot drift.
 * `npm run docs` fills every `<!-- flow:NAME -->…<!-- /flow:NAME -->` block of the
 * docs with the pattern's phase view (groups collapsed) as a mermaid flowchart and a
 * table of its phases; a test fails when a committed doc is out of date.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { phaseView } from './core/graph.js';
import type { Pattern, ScoreNode } from './core/types.js';
import { findPattern } from './patterns/index.js';

/** Docs that hold generated flow blocks. */
export const FLOW_DOCS = ['docs/patterns.md', 'docs/maestro.md'] as const;

const BLOCK = /<!-- flow:([\w-]+) -->[\s\S]*?<!-- \/flow:\1 -->/g;

const text = (s: string) => s.replace(/"/g, '#quot;').replace(/\n/g, ' ');

function shape(node: ScoreNode): string {
  const label = text(node.label);
  switch (node.kind) {
    case 'start':
      return `(["${label}"])`;
    case 'end':
      return `(["${label} · ${node.outcome}"])`;
    case 'condition':
      return `{"${label}"}`;
    case 'approval':
      return `{{"👤 ${label}"}}`;
    case 'agent':
      return `["🤖 ${label}${node.role === 'executor' ? ' (edits)' : ''}${node.fanOut ? ' ×N' : ''}"]`;
    case 'tool':
      return `[/"🔧 ${label}"/]`;
    default:
      return `["${label}"]`;
  }
}

/** Mermaid id: prefixed, since "end" and the like are keywords there. */
const id = (s: string) => `n_${s}`;

/** The pattern's phase view as a mermaid flowchart (each group one box). */
export function flowchart(pattern: Pattern): string {
  const view = phaseView(pattern, new Set());
  const byId = new Map(pattern.nodes.map((n) => [n.id, n]));
  const lines = ['```mermaid', 'flowchart TD'];
  for (const n of view.nodes) {
    if (n.kind === 'phase')
      lines.push(`  ${id(n.id)}[["${text(n.group!.label)} · ${n.members.length} steps"]]`);
    else lines.push(`  ${id(n.id)}${shape(byId.get(n.id)!)}`);
  }
  for (const e of view.edges) {
    const label =
      e.label ??
      (e.sourceHandle === 'then' ? 'yes' : e.sourceHandle === 'else' ? 'no' : e.sourceHandle);
    const arrow = e.back ? '-.->' : '-->';
    lines.push(`  ${id(e.source)} ${arrow}${label ? `|"${text(label)}"|` : ''} ${id(e.target)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

/** What each phase box holds: its description and steps. */
export function phaseTable(pattern: Pattern): string {
  const groups = pattern.groups ?? [];
  if (groups.length === 0) return '';
  const label = (nid: string) => pattern.nodes.find((n) => n.id === nid)?.label ?? nid;
  return [
    '| Phase | What it does | Steps |',
    '| --- | --- | --- |',
    ...groups.map(
      (g) =>
        `| ${g.label} | ${(g.description ?? '').replace(/\|/g, '/')} | ${g.nodes.map(label).join(' → ').replace(/\|/g, '/')} |`,
    ),
  ].join('\n');
}

/** The generated block for one pattern. */
export function flowBlock(name: string): string {
  const pattern = findPattern(name);
  if (!pattern) throw new Error(`docs: no pattern '${name}'`);
  const table = phaseTable(pattern);
  return [
    `<!-- flow:${name} -->`,
    `<!-- Generated from src/patterns by \`npm run docs\`: edit the pattern, not this block. -->`,
    '',
    flowchart(pattern),
    ...(table ? ['', table] : []),
    '',
    `<!-- /flow:${name} -->`,
  ].join('\n');
}

/** The doc with every flow block regenerated. */
export function updateFlows(markdown: string): string {
  return markdown.replace(BLOCK, (_, name: string) => flowBlock(name));
}

if (process.argv[1]?.endsWith('flows.ts')) {
  for (const file of FLOW_DOCS) {
    const before = readFileSync(file, 'utf8');
    const after = updateFlows(before);
    if (after !== before) writeFileSync(file, after);
    console.log(`${after === before ? 'up to date' : 'updated'}: ${file}`);
  }
}
