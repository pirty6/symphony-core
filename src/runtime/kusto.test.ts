import { describe, expect, it } from 'vitest';
import {
  clusterUrl,
  formatTable,
  KUSTO_MAX_ROWS,
  kustoQuery,
  kustoRefusal,
  type KustoDeps,
} from './kusto.js';

const signal = new AbortController().signal;

describe('kustoRefusal', () => {
  it.each([
    'TestHealthV2 | where Timestamp > ago(30d) | summarize count() by Package',
    'let t = TestHealthV2; t | take 5',
    '.show table TestHealthV2 policy retention',
    '// .drop table T is only a comment here\nT | take 1',
  ])('allows %s', (q) => expect(kustoRefusal(q)).toBeUndefined());

  it.each([
    ['.drop table TestHealthV2', /\.drop table/],
    ['T | take 1;\n.set-or-append T2 <| T', /\.set-or-append/],
    ['.alter table T policy retention "{}"', /\.alter table/],
    ['   ', /empty/],
  ])('refuses %s', (q, why) => expect(kustoRefusal(q)).toMatch(why));
});

describe('clusterUrl', () => {
  it('takes a bare name or a Kusto https URL, nothing else', () => {
    expect(clusterUrl('bohemiahealth')).toBe('https://bohemiahealth.kusto.windows.net');
    expect(clusterUrl('https://x.westus.kusto.windows.net/db')).toBe(
      'https://x.westus.kusto.windows.net',
    );
    expect(clusterUrl('http://x.kusto.windows.net')).toBeUndefined();
    expect(clusterUrl('https://evil.example.com')).toBeUndefined();
  });
});

describe('kustoQuery', () => {
  const answer = {
    Tables: [
      {
        Columns: [{ ColumnName: 'Package' }, { ColumnName: 'Flaky' }],
        Rows: [
          ['ui', 3],
          ['core', 0],
        ],
      },
    ],
  };
  const deps = (seen: { url?: string; body?: string; auth?: string }): KustoDeps => ({
    token: async () => 'tok',
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.body = String(init.body);
      seen.auth = (init.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch,
  });

  it('queries with the caller’s token and answers a table; .show goes to mgmt', async () => {
    const seen: { url?: string; body?: string; auth?: string } = {};
    const out = await kustoQuery(
      { cluster: 'bohemiahealth', database: 'Health', query: 'T | take 2' },
      deps(seen),
      signal,
    );
    expect(out).toBe('Package\tFlaky\nui\t3\ncore\t0');
    expect(seen).toEqual({
      url: 'https://bohemiahealth.kusto.windows.net/v1/rest/query',
      body: JSON.stringify({ db: 'Health', csl: 'T | take 2' }),
      auth: 'Bearer tok',
    });
    await kustoQuery(
      { cluster: 'bohemiahealth', database: 'Health', query: '.show tables' },
      deps(seen),
      signal,
    );
    expect(seen.url).toBe('https://bohemiahealth.kusto.windows.net/v1/rest/mgmt');
  });

  it('never sends a control command, and says why it could not run', async () => {
    const seen: { url?: string } = {};
    expect(
      await kustoQuery({ cluster: 'c', database: 'd', query: '.drop table T' }, deps(seen), signal),
    ).toMatch(/^kusto_query refused: `\.drop table` is a control command/);
    expect(seen.url).toBeUndefined();
    const noLogin: KustoDeps = {
      ...deps({}),
      token: async () => Promise.reject(new Error('Please run az login')),
    };
    expect(await kustoQuery({ cluster: 'c', database: 'd', query: 'T' }, noLogin, signal)).toMatch(
      /no Azure sign-in .* \(run az login\)/,
    );
  });

  it('cuts a long answer and says how many rows were left out', () => {
    const rows = Array.from({ length: KUSTO_MAX_ROWS + 5 }, (_, i) => [i]);
    const out = formatTable({ Tables: [{ Columns: [{ ColumnName: 'n' }], Rows: rows }] });
    expect(out.split('\n')).toHaveLength(KUSTO_MAX_ROWS + 2);
    expect(out).toMatch(/… 5 more row\(s\) not shown/);
  });
});
