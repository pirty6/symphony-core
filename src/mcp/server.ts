/**
 * Symphony as an MCP server: the same deterministic pipeline (maestro, patterns,
 * gates, approvals) as tools any MCP client can call: VS Code agents over stdio,
 * Copilot Studio over Streamable HTTP. Runs go on in the background; the caller
 * polls get_run and relays approvals and stuck steps to the human in its chat.
 */
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Complexity, Improvisation } from '../core/types.js';
import { DEBATE_ROLES } from '../patterns/maestro.js';
import { editsFiles, type RunManager, type RunView } from './runs.js';

export const SERVER_INFO = { name: 'symphony', version: '1.0.0' } as const;
const MAX_WAIT = 55;

const complexity = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
  .optional()
  .describe('Model tier 1-4 (4 = smartest; also scales the debate). Omit to let it decide.');
const improvisation = z
  .number()
  .int()
  .min(0)
  .max(4)
  .optional()
  .describe('0 classical (replays recorded answers) to 4 free jazz. Default 0.');
const provider = z
  .enum(['copilot', 'scripted'])
  .optional()
  .describe("'copilot' (default) for real AI; 'scripted' plays the offline demo's canned answers.");
const autoApprove = z
  .boolean()
  .optional()
  .describe('Approve every human gate automatically. Leave false so the user decides.');

function json(view: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(view, null, 2) }] };
}

function failure(e: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: (e as Error).message }],
  };
}

const NEXT = `Then call get_run with this run_id until it settles. When waitingFor is set, show it to the user and relay their decision (answer_approval or answer_stuck). When outcome is set, show result.`;

/** Resolve the folder to work in: SYMPHONY_WORKSPACE, the client's first root, or cwd. */
export async function clientWorkspace(server: McpServer, env: NodeJS.ProcessEnv): Promise<string> {
  if (env.SYMPHONY_WORKSPACE) return env.SYMPHONY_WORKSPACE;
  if (server.server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.server.listRoots();
      const first = roots.find((r) => r.uri.startsWith('file:'));
      if (first) return fileURLToPath(first.uri);
    } catch {
      // the client could not list roots: fall back to the process folder
    }
  }
  return process.cwd();
}

export function createSymphonyServer(runs: RunManager): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Symphony runs deterministic, auditable AI pipelines. Start with maestro (any request) or run_pattern, then poll get_run. Never invent approvals: ask the user, then answer_approval / answer_stuck.',
  });

  server.registerTool(
    'list_patterns',
    {
      title: 'List Symphony patterns',
      description:
        'The pipelines Symphony can run: name, what it does, its required inputs, and whether it edits files.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const lib = await runs.library();
      return json(
        lib
          .filter((p) => p.name !== 'hangman')
          .map((p) => ({
            name: p.name,
            description: p.description,
            requiredInputs: p.requiredContext,
            editsFiles: editsFiles(p),
            available: runs.editsAllowed || !editsFiles(p),
          })),
      );
    },
  );

  server.registerTool(
    'maestro',
    {
      title: 'Ask the maestro',
      description: `Run the maestro meta-pipeline on a request: it routes to the right pattern, debates the algorithm (${DEBATE_ROLES.join(', ')} by complexity), validates it, asks for a go, then performs the composed score (and a follow-up pattern when the request asks for two shapes). Returns a run_id. ${NEXT}`,
      inputSchema: {
        request: z.string().min(1).describe("The user's problem, verbatim"),
        complexity,
        improvisation,
        provider,
        auto_approve: autoApprove,
      },
    },
    async (a) => {
      try {
        const id = await runs.start({
          pattern: 'maestro',
          inputs: { request: a.request },
          ...(a.complexity ? { complexity: a.complexity as Complexity } : {}),
          ...(a.improvisation !== undefined
            ? { improvisation: a.improvisation as Improvisation }
            : {}),
          ...(a.provider ? { provider: a.provider } : {}),
          autoApprove: a.auto_approve === true,
        });
        return json({ run_id: id, ...(await runs.wait(id, 5)) });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'run_pattern',
    {
      title: 'Run a Symphony pattern',
      description: `Run one pattern directly (see list_patterns), optionally chaining more after it: each next pattern gets what the previous found. Returns a run_id. ${NEXT}`,
      inputSchema: {
        pattern: z.string().describe('Pattern name from list_patterns'),
        inputs: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Run inputs, e.g. { "question": "..." } or { "issue": "...", "testCommand": "npm test" }',
          ),
        chain: z
          .array(z.string())
          .optional()
          .describe('Patterns to play after it with its result, e.g. ["fix"]'),
        complexity,
        improvisation,
        provider,
        auto_approve: autoApprove,
      },
    },
    async (a) => {
      try {
        const id = await runs.start({
          pattern: a.pattern,
          ...(a.inputs ? { inputs: a.inputs } : {}),
          ...(a.chain ? { chain: a.chain } : {}),
          ...(a.complexity ? { complexity: a.complexity as Complexity } : {}),
          ...(a.improvisation !== undefined
            ? { improvisation: a.improvisation as Improvisation }
            : {}),
          ...(a.provider ? { provider: a.provider } : {}),
          autoApprove: a.auto_approve === true,
        });
        return json({ run_id: id, ...(await runs.wait(id, 5)) });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'get_run',
    {
      title: 'Check a Symphony run',
      description:
        'Wait (up to wait_seconds) until the run needs a human or ends, then report: status, the step it is on, recent events, waitingFor (an approval with what to show, or a stuck step with why), and when it ended, outcome and result (Markdown). Follows hand-offs (maestro -> composed score -> chained patterns): runId is the latest run.',
      inputSchema: {
        run_id: z.string(),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT).optional().describe('Default 30'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        return json(await runs.wait(a.run_id, a.wait_seconds ?? 30));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'answer_approval',
    {
      title: 'Answer an approval',
      description:
        "Relay the user's decision at an approval (waitingFor.kind = 'approval'). Only call this after the user decided. updates fills waitingFor.fields when the step asks for values.",
      inputSchema: {
        run_id: z.string(),
        approved: z.boolean(),
        updates: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (a) => {
      try {
        const view: RunView = runs.answerApproval(a.run_id, {
          approved: a.approved,
          ...(a.updates ? { updates: a.updates } : {}),
        });
        return json(view);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'answer_stuck',
    {
      title: 'Retry or stop a stuck step',
      description:
        "An AI step used up its attempts (waitingFor.kind = 'stuck'). Relay the user's decision: retry (optionally with a hint for the AI and a higher complexity for a smarter model) or stop the run.",
      inputSchema: {
        run_id: z.string(),
        action: z.enum(['retry', 'stop']),
        hint: z.string().optional(),
        complexity,
      },
    },
    async (a) => {
      try {
        return json(
          runs.answerStuck(a.run_id, {
            action: a.action,
            ...(a.hint ? { hint: a.hint } : {}),
            ...(a.complexity ? { complexity: a.complexity as Complexity } : {}),
          }),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'stop_run',
    {
      title: 'Stop a run',
      description:
        'Stop a run: any run id of a chain stops the run playing now (maestro -> composed -> chained). Waits for its current step to end; status "stopping" means it is still winding down. It is saved and can be resumed or forked later from the studio or CLI.',
      inputSchema: { run_id: z.string() },
    },
    async (a) => {
      try {
        return json(await runs.stop(a.run_id));
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
