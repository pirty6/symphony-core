/**
 * Whether a prompt contains a pattern's verb trigger as whole words, allowing the
 * usual verb endings: 'fix' matches "fixing" and "fixes", 'add' matches "added"
 * but not "address", 'data' does not match "database".
 */
export function triggerMatches(text: string, trigger: string): boolean {
  const t = trigger.trim().toLowerCase();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:s|es|ed|d|ing)?(?![a-z0-9])`, 'i').test(text);
}
