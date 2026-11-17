import { describe, expect, it } from 'vitest';
import { CODE_PILLARS, lensBrief, pillarById } from './pillars.js';

describe('pillar rulebooks', () => {
  it('a brief starts with its pillar id and holds its rules and its leads', () => {
    const brief = lensBrief(pillarById('SECURITY'), [
      'src/db.ts:1 — a query built from values (SEC-1)',
    ]);
    expect(brief.startsWith('SECURITY — Security:')).toBe(true);
    expect(brief).toContain('- SEC-2: No secret, token, key or password');
    expect(brief).toContain('- src/db.ts:1 — a query built from values (SEC-1)');
  });

  it('only the Tests brief carries the critical-path procedure', () => {
    expect(lensBrief(pillarById('TESTS'), [])).toContain(
      'DOMAIN (decides much, few collaborators)',
    );
    expect(lensBrief(pillarById('PERFORMANCE'), [])).not.toContain('DOMAIN (decides much');
  });

  it('a brief without leads says the scan found none', () => {
    expect(lensBrief(pillarById('DETERMINISM'), [])).toContain(
      "The engine's scan found no leads for this pillar.",
    );
  });

  it('every rule id is unique across the pillars', () => {
    const ids = CODE_PILLARS.flatMap((p) => p.rules.map(([id]) => id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
