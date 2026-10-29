/**
 * Names shared by every surface (runtime, studio, integrations), kept in one
 * browser-safe place. The runtime's tool registry must match TOOL_OUTPUTS: a test
 * fails when they drift.
 */
import type { Complexity } from './types.js';

/** The built-in tools and what each one returns (src/runtime/builtin-tools.ts). */
export const TOOL_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  'repo.files': ['files', 'excluded'],
  'sources.catalog': ['names', 'descriptions'],
  'tests.run': ['passed', 'output', 'command'],
  'git.diff': ['diff', 'hash', 'files'],
  'evidence.check': ['valid', 'invalid'],
  'memory.recall': ['facts', 'lessons'],
  'memory.lesson': ['saved'],
  'patterns.list': ['names', 'summaries', 'catalog'],
  'patterns.route': ['suggested', 'matches'],
  'pattern.validate': ['errors', 'valid', 'pattern', 'inputs'],
  'compositions.recall': ['exact', 'similar'],
  'compositions.remember': ['saved'],
  'pattern.outline': ['steps', 'settings'],
  'pattern.save': ['file', 'name'],
};

/** What each complexity tier means, in a word or two. */
export const TIER_NAMES: Readonly<Record<Complexity, string>> = {
  1: 'routine',
  2: 'some judgement',
  3: 'risky',
  4: 'novel',
};
