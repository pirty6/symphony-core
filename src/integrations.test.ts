/**
 * The integrations (VS Code agent and skill, Copilot Studio instructions, the MCP
 * descriptions) describe the same tools, options and patterns as the code. These
 * tests fail when one drifts, so a new tool option or pattern cannot be forgotten.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { skillFromAgent } from './install-vscode.js';
import { RunManager } from './mcp/runs.js';
import { createSymphonyServer } from './mcp/server.js';
import { maestro, workPatternNames } from './patterns/index.js';
import { DEBATE_ROLES } from './patterns/maestro.js';

const doc = (path: string) => readFileSync(join(import.meta.dirname, '..', path), 'utf8');
const DOCS = {
  'Copilot Studio instructions': doc('integrations/copilot-studio/instructions.md'),
  'VS Code agent': doc('integrations/vscode/maestro-v2.agent.md'),
};

/** Named in code style: `name`, or at the start of one (`wait_seconds: 50`, `updates.feedback`). */
const mentioned = (name: string) => new RegExp(`\`${name}\\b`);

const workspace = mkdtempSync(join(tmpdir(), 'symphony-integrations-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

async function mcpTools() {
  const runs = new RunManager({
    workspace: async () => workspace,
    repoRoot: workspace,
    env: { SYMPHONY_MCP: 'off' },
    editsAllowed: true,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createSymphonyServer(runs).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return (await client.listTools()).tools;
}

describe('integrations describe what the code offers', () => {
  it('every MCP tool and every option it takes is in the Copilot Studio and VS Code instructions', async () => {
    const tools = await mcpTools();
    expect(tools.length).toBeGreaterThan(5);
    for (const [name, text] of Object.entries(DOCS)) {
      for (const tool of tools) {
        expect(text, `${name}: tool ${tool.name}`).toMatch(mentioned(tool.name));
        for (const option of Object.keys(tool.inputSchema.properties ?? {}))
          expect(text, `${name}: ${tool.name}.${option}`).toMatch(mentioned(option));
      }
    }
  });

  it('the agent and the skill list the core patterns, from the library', () => {
    const listed = /pipelines? \(([^)]*)\)/.exec(DOCS['VS Code agent'])?.[1]?.split(/,\s*/);
    expect(listed).toEqual(workPatternNames());
    const skill = skillFromAgent(DOCS['VS Code agent']);
    expect(/pipeline \(([^)]*)\)/.exec(skill)?.[1]?.split(/,\s*/)).toEqual(workPatternNames());
  });

  it('the debate roles are named as the maestro names its steps', async () => {
    const tools = await mcpTools();
    const described = tools.find((t) => t.name === 'maestro')!.description!;
    for (const role of DEBATE_ROLES) {
      expect(described).toContain(role);
      expect(maestro.description).toContain(role);
    }
  });
});
