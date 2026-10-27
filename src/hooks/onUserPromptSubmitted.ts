import type { SessionConfig } from '@github/copilot-sdk';

type Hooks = NonNullable<SessionConfig['hooks']>;
type Handler = NonNullable<Hooks['onUserPromptSubmitted']>;

export const onUserPromptSubmitted = async (
  input: Parameters<Handler>[0],
): Promise<{ modifiedPrompt: string }> => {
  console.log(`[server] ─── onUserPromptSubmitted (session=${input.sessionId}) ───`);
  console.log(
    `  prompt (${input.prompt.length} chars): ${input.prompt.slice(0, 200)}${input.prompt.length > 200 ? '…' : ''}`,
  );
  return { modifiedPrompt: input.prompt };
};
