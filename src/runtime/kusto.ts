/**
 * Kusto (Azure Data Explorer) for agents, read-only by construction: a query, or a `.show`
 * command, never another control command (those start with "."). The caller's own Azure sign-in
 * (`az`) gives the token; nothing is stored.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Rows and characters an answer may hold: an agent reads it whole. */
export const KUSTO_MAX_ROWS = 200;
export const KUSTO_MAX_CHARS = 20_000;

/** Hosts a cluster may be on: Azure Data Explorer, its Microsoft and Fabric clouds. */
const KUSTO_HOST =
  /\.(kusto\.windows\.net|kusto\.data\.microsoft\.com|kusto\.fabric\.microsoft\.com|kustomfa\.windows\.net)$/;

/** The cluster's https origin, from a URL or a bare name ("help" → https://help.kusto.windows.net). */
export function clusterUrl(cluster: string): string | undefined {
  const c = cluster.trim();
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)?$/i.test(c) && !c.includes('.kusto'))
    return `https://${c.toLowerCase()}.kusto.windows.net`;
  try {
    const u = new URL(c);
    return u.protocol === 'https:' && KUSTO_HOST.test(u.hostname) ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Why a query is not read-only, or undefined: control commands other than .show change things. */
export function kustoRefusal(query: string): string | undefined {
  const text = query.replace(/\/\/[^\n]*/g, '');
  if (!text.trim()) return 'the query is empty';
  const starts = [...text.split(';'), ...text.split('\n')].map((s) => s.trim());
  const command = starts.find((s) => s.startsWith('.') && !/^\.show\b/i.test(s));
  return command
    ? `\`${command.split(/\s+/).slice(0, 2).join(' ')}\` is a control command (only queries and .show are allowed)`
    : undefined;
}

interface KustoTable {
  readonly Columns?: readonly { readonly ColumnName: string }[];
  readonly Rows?: readonly (readonly unknown[])[];
}

/** The first table of a v1 response as tab-separated text, cut to what an agent can read. */
export function formatTable(json: { readonly Tables?: readonly KustoTable[] }): string {
  const t = json.Tables?.[0];
  if (!t?.Columns) return 'No table in the answer.';
  const cell = (v: unknown) =>
    (typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/[\t\n]/g, ' ');
  const rows = t.Rows ?? [];
  const lines = [t.Columns.map((c) => c.ColumnName).join('\t')];
  let size = lines[0]!.length;
  let shown = 0;
  for (const r of rows.slice(0, KUSTO_MAX_ROWS)) {
    const line = r.map(cell).join('\t');
    if (size + line.length > KUSTO_MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
    shown += 1;
  }
  if (shown < rows.length)
    lines.push(
      `… ${rows.length - shown} more row(s) not shown: narrow the query (where, summarize, take).`,
    );
  return lines.join('\n');
}

export interface KustoDeps {
  /** An access token for the cluster, from the caller's Azure sign-in. */
  readonly token: (resource: string, signal: AbortSignal) => Promise<string>;
  readonly fetch: typeof fetch;
}

export const defaultKustoDeps: KustoDeps = {
  token: async (resource, signal) =>
    (
      await run(
        'az',
        [
          'account',
          'get-access-token',
          '--resource',
          resource,
          '--query',
          'accessToken',
          '-o',
          'tsv',
        ],
        { signal },
      )
    ).stdout.trim(),
  fetch: (...a) => fetch(...a),
};

/** Run a read-only query; always answers with text (a table, or why it could not run). */
export async function kustoQuery(
  args: { readonly cluster: string; readonly database: string; readonly query: string },
  deps: KustoDeps,
  signal: AbortSignal,
): Promise<string> {
  const origin = clusterUrl(args.cluster);
  if (!origin)
    return `kusto_query: not a Kusto cluster: ${args.cluster} (give its name or https URL)`;
  if (!args.database.trim()) return 'kusto_query: database is required';
  const refused = kustoRefusal(args.query);
  if (refused) return `kusto_query refused: ${refused}`;
  let token: string;
  try {
    token = await deps.token(origin, signal);
  } catch (e) {
    return `kusto_query: no Azure sign-in for ${origin} (run az login): ${(e as Error).message.split('\n')[0]}`;
  }
  const mgmt = /^\s*\.show\b/i.test(args.query.replace(/\/\/[^\n]*/g, ''));
  try {
    const res = await deps.fetch(`${origin}/v1/rest/${mgmt ? 'mgmt' : 'query'}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ db: args.database.trim(), csl: args.query }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) return `kusto_query failed (${res.status}): ${text.slice(0, 500)}`;
    return formatTable(JSON.parse(text) as { Tables?: KustoTable[] });
  } catch (e) {
    return `kusto_query failed: ${(e as Error).message}`;
  }
}
