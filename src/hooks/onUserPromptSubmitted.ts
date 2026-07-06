import type {  UserPromptSubmittedHookOutput, UserPromptSubmittedHookInput } from '@github/copilot-sdk/types';


export async function onUserPromptSubmitted(input: UserPromptSubmittedHookInput): Promise<UserPromptSubmittedHookOutput> {
  console.log(`User prompt received: ${input.prompt.slice(0, 80)}...`);
  return {
    modifiedPrompt: input.prompt,
  };
}