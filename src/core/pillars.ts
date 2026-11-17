/**
 * The pillars a change to code is judged by, each with its rulebook. Review, implement, fix and
 * investigate (for questions about code) look at a change through one lens per pillar: a
 * deterministic scan (core/lensscan.ts), then an AI reviewer that judges only that pillar.
 *
 * The rules are in our own words. Clean code follows "Clean Code" (Robert C. Martin, 2008; the
 * rules and ids live in core/standards.ts); tests follow "Unit Testing Principles, Practices,
 * and Patterns" (Vladimir Khorikov, 2020), its rule ids UT-<chapter>.<n>.
 */
import { CLEAN_CODE_IDS, CLEAN_CODE_RULES } from './standards.js';

export type PillarId =
  | 'CORRECTNESS'
  | 'SECURITY'
  | 'CLEAN'
  | 'TESTS'
  | 'PERFORMANCE'
  | 'DETERMINISM';

type Rule = readonly [id: string, text: string];

export interface CodePillar {
  readonly id: PillarId;
  readonly name: string;
  /** The question the lens answers about a change. */
  readonly asks: string;
  /** The review categories its findings use. */
  readonly categories: readonly string[];
  readonly rules: readonly Rule[];
}

const CORRECTNESS: CodePillar = {
  id: 'CORRECTNESS',
  name: 'Correctness',
  asks: 'Does the change do what it says, in the right place, for every input it can get?',
  categories: ['BUG', 'CLAIM', 'ERRPATH', 'COMPAT', 'MISSING'],
  rules: [
    ['COR-1', 'The change does what its title, description or claims say, in the right place.'],
    [
      'COR-2',
      'Boundaries hold: off by one, empty, null or undefined, zero, negative, the maximum, other locales and time zones.',
    ],
    [
      'COR-3',
      'Every new branch handles its error result; nothing is swallowed or reported as success.',
    ],
    [
      'COR-4',
      'Callers, stored data and other services that rely on a changed signature, format or default still work.',
    ],
    ['COR-5', "The behaviour matches the code's own docs and comments, which the change updates."],
  ],
};

const SECURITY: CodePillar = {
  id: 'SECURITY',
  name: 'Security',
  asks: 'Can this change leak a secret, or let untrusted input do something it should not?',
  categories: ['SECURITY'],
  rules: [
    [
      'SEC-1',
      'Untrusted input never reaches a shell, a query, HTML, a file path or a fetched URL without parameters, escaping or an allow-list (injection, XSS, path traversal, SSRF).',
    ],
    ['SEC-2', 'No secret, token, key or password in code, config, logs, errors or fixtures.'],
    [
      'SEC-3',
      'Every new entry point (route, handler, command, tool) checks who may call it and what they may touch, with the least privilege that works.',
    ],
    [
      'SEC-4',
      'Input is validated where it crosses a trust boundary (type, size, range, format), and rejected rather than repaired.',
    ],
    ['SEC-5', 'No eval, new Function, unsafe deserialization or dynamic require on data.'],
    [
      'SEC-6',
      'TLS and certificate checks stay on; session cookies are HttpOnly, Secure and SameSite.',
    ],
    [
      'SEC-7',
      'Tokens, ids and nonces that must not be guessed come from a cryptographic random source.',
    ],
    ['SEC-8', 'Errors and logs show callers neither internals nor personal data.'],
    ['SEC-9', 'A new dependency is needed, maintained and pinned, and the lockfile matches it.'],
    [
      'SEC-10',
      'Files, folders and processes are created with the least permissions and cleaned up.',
    ],
  ],
};

const CLEAN: CodePillar = {
  id: 'CLEAN',
  name: 'Clean code',
  asks: 'Is the new and edited code clean (Clean Code, Robert C. Martin)?',
  categories: ['CLEAN', 'REDUNDANT', 'DESIGN'],
  rules: [
    ...CLEAN_CODE_RULES.map((text, i): Rule => [`CC-${i + 1}`, text]),
    ...CLEAN_CODE_IDS.map(([id, gloss]): Rule => [id, `Smell: ${gloss}.`]),
  ],
};

const TESTS: CodePillar = {
  id: 'TESTS',
  name: 'Tests',
  asks: 'Does the critical path have tests that would fail if it broke, and are those tests good unit tests (Khorikov)?',
  categories: ['TEST', 'FLAKY'],
  rules: [
    [
      'UT-1.1',
      'Test what would hurt users if it broke; coverage finds untested code, it does not prove a test is good.',
    ],
    ['UT-2.1', 'A unit is a behaviour, not a class: keep in-process collaborators real.'],
    ['UT-3.1', 'Arrange, one act, assert: one behaviour per test.'],
    [
      'UT-3.2',
      'No if, switch, loop, try/finally or test.each inside a test body: each case is its own named test.',
    ],
    [
      'UT-3.3',
      'A test is named for its scenario and expected outcome, not for the method it calls.',
    ],
    [
      'UT-3.4',
      'Tests share no mutable state and no order; cleanup goes in afterEach, not in the test body.',
    ],
    [
      'UT-4.1',
      'Assert what callers can observe (a result, a state, an external effect), never private state or internal call order: a refactor must not break a test.',
    ],
    ['UT-4.2', 'A unit test is fast: no real network, sleeps or slow infrastructure.'],
    [
      'UT-5.1',
      'Mock only unmanaged out-of-process dependencies (mail, message bus, third-party APIs); stub the rest, and never assert calls on a stub.',
    ],
    ['UT-6.1', 'Prefer checking the output, then the state, and only then the communication.'],
    ['UT-7.1', 'Expected values are literals, never recomputed with the production formula.'],
    [
      'UT-7.2',
      'Domain logic and algorithms get unit tests; coordination code gets integration tests; trivial code needs none; overcomplicated code is split first (a humble object around the logic).',
    ],
    [
      'UT-8.1',
      'Integration tests use the real managed dependencies (your own database, files) and cover their failures at the boundary.',
    ],
    [
      'UT-11.1',
      'Private behaviour is tested through the public API: no test-only accessors, flags or branches in production code.',
    ],
    ['UT-11.2', 'Time and randomness are inputs; no sleeps or retries hide nondeterminism.'],
    ['UT-T', 'A test that would still pass without the change it covers is WEAK.'],
  ],
};

const PERFORMANCE: CodePillar = {
  id: 'PERFORMANCE',
  name: 'Performance and memory',
  asks: 'Does the change do needless work, or hold memory it does not release?',
  categories: ['PERF'],
  rules: [
    [
      'PERF-1',
      'No I/O, query or network call per item inside a loop where one batched call would do.',
    ],
    [
      'PERF-2',
      'No quadratic work over inputs that can grow (nested loops, repeated scans of an array).',
    ],
    ['PERF-3', 'Caches, maps, arrays, listeners and timers that grow are bounded or released.'],
    ['PERF-4', 'No synchronous file, network or heavy CPU work on a hot or request path.'],
    ['PERF-5', 'Large data is streamed or paged, not loaded or copied whole.'],
  ],
};

const DETERMINISM: CodePillar = {
  id: 'DETERMINISM',
  name: 'Determinism',
  asks: 'Can the change behave differently from run to run (races, order, time, flaky tests)?',
  categories: ['CONCURRENCY', 'FLAKY'],
  rules: [
    ['DET-1', 'Promises are awaited or their failure is handled; nothing is fire-and-forget.'],
    [
      'DET-2',
      'Shared mutable state has one owner or a lock; no check-then-act between concurrent callers.',
    ],
    [
      'DET-3',
      'Logic whose result matters does not read the clock, random numbers or the environment directly: they come in as inputs.',
    ],
    ['DET-4', 'Visible order is sorted: sets, maps, file listings and parallel results.'],
    ['DET-5', 'Tests do not depend on timing, the real clock, order, the network or each other.'],
  ],
};

export const CODE_PILLARS: readonly CodePillar[] = [
  CORRECTNESS,
  SECURITY,
  CLEAN,
  TESTS,
  PERFORMANCE,
  DETERMINISM,
];

export const pillarById = (id: PillarId): CodePillar => CODE_PILLARS.find((p) => p.id === id)!;

/**
 * How the Tests lens finds the critical path (Khorikov, ch. 7): two axes per changed unit of
 * production code, then a quadrant that says what testing it needs.
 */
export const CRITICAL_PATH_STEPS: readonly string[] = [
  'For each function or class the change adds or edits in production code, rate how much it decides: branches, calculations, business rules, invariants, algorithms (domain significance and complexity).',
  'Count its collaborators: other components it calls, and especially out-of-process ones (database, files, network, other services).',
  'DOMAIN (decides much, few collaborators): the critical path; it must have unit tests on its outcomes and its edge cases.',
  'CONTROLLER (decides little, many collaborators): an integration test of the important path and its failure at the boundary.',
  'TRIVIAL (decides little, few collaborators): needs no test.',
  'OVERCOMPLICATED (decides much, many collaborators): split it first (a humble object: the decisions in a domain unit, the wiring in a thin layer), then test as above; until then it is a finding.',
];

const rulesText = (p: CodePillar): string =>
  p.rules.map(([id, text]) => `- ${id}: ${text}`).join('\n');

const leadsText = (leads: readonly string[]): string =>
  leads.length > 0
    ? `Leads from the engine's scan (check each; report only the real ones):\n${leads.map((l) => `- ${l}`).join('\n')}`
    : "The engine's scan found no leads for this pillar.";

/**
 * One lens's brief: the pillar, its rulebook and the scan's leads for it. A brief starts with the
 * pillar's id, which is how a reviewer's note names the lens it answers.
 */
export function lensBrief(pillar: CodePillar, leads: readonly string[]): string {
  const critical =
    pillar.id === 'TESTS'
      ? `\nThe critical path, step by step:\n${CRITICAL_PATH_STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '';
  return `${pillar.id} — ${pillar.name}: ${pillar.asks}
Findings use the categories ${pillar.categories.join(', ')}, with the rule id after the severity.
Rules:
${rulesText(pillar)}${critical}
${leadsText(leads)}`;
}
