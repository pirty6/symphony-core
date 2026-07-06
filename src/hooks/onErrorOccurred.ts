import type { ErrorOccurredHookInput, ErrorOccurredHookOutput } from '@github/copilot-sdk/types';

export async function onErrorOccurred(input: ErrorOccurredHookInput): Promise<ErrorOccurredHookOutput> {
 console.error(`Error in ${input.errorContext}: ${input.error}`);
    return {
      errorHandling: 'abort'
    };
}