import type {  UserPromptSubmittedHookOutput, UserPromptSubmittedHookInput } from '@github/copilot-sdk/types';


export async function onUserPromptSubmitted(input: UserPromptSubmittedHookInput): Promise<UserPromptSubmittedHookOutput> {
  console.log(`[server] ─── onUserPromptSubmitted (session=${input.sessionId}) ───`);
  console.log(`  prompt (${input.prompt.length} chars): ${input.prompt.slice(0, 200)}${input.prompt.length > 200 ? '…' : ''}`);
  return {
    modifiedPrompt: input.prompt,
  };
}