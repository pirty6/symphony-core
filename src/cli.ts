import { CopilotClient } from '@github/copilot-sdk';
import type { SessionConfig } from '@github/copilot-sdk';
import {onErrorOccurred} from './hooks/onErrorOccurred';
import { onUserPromptSubmitted } from './hooks/onUserPromptSubmitted';

type SessionHooks = NonNullable<SessionConfig['hooks']>;

const hooks: SessionHooks = {
  onSessionStart: async (input: { source: string }) => {
    console.log(`Session started from: ${input.source}`);
    return {
      additionalContext: 'Symphony orchestrator session initialized.',
    };
  },

  onSessionEnd: async (input: { reason: string }) => {
    console.log(`Session ended: ${input.reason}`);
  },

  onUserPromptSubmitted,

  onPreToolUse: async (input: { toolName: string; toolArgs: unknown }) => {
    console.log(`Tool about to run: ${input.toolName}`);
    return {
      permissionDecision: 'allow' as const,
      modifiedArgs: input.toolArgs,
    };
  },

  onPostToolUse: async (input: { toolName: string }) => {
    console.log(`Tool ${input.toolName} completed`);
    return {};
  },

  onPostToolUseFailure: async (input: { toolName: string; error: string }) => {
    console.log(`Tool ${input.toolName} failed: ${input.error}`);

    // Replicate stop-on-error behavior for terminal failures
    if (input.toolName === 'run_in_terminal') {
      return {
        additionalContext:
          'Terminal command failed with a non-zero exit code. Stop and report the error to the user.',
      };
    }

    return {
      additionalContext: 'Suggest checking inputs and retrying.',
    };
  },

  onErrorOccurred
};


async function main(): Promise<void> {
    const client = new CopilotClient();
    await client.start();

    const session = await client.createSession({
    hooks,
  });

  const done = new Promise<void>((resolve) => {
    session.on('assistant.message', (event) => {
      console.log(event.data.content);
    });
    session.on('session.idle', () => {
      resolve();
    });
  });

  await session.send({ prompt: 'Hello from Symphony' });
  await done;

  await session.disconnect();
  await client.stop();
}

try {
  main();
} catch(error) {
  console.log(error);
}