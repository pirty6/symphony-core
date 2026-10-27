import type { SessionConfig } from '@github/copilot-sdk';

type Hooks = NonNullable<SessionConfig['hooks']>;
type Handler = NonNullable<Hooks['onErrorOccurred']>;

export const onErrorOccurred = async (
  input: Parameters<Handler>[0],
): Promise<{ errorHandling: 'abort' }> => {
  console.error(`Error in ${input.errorContext}: ${input.error}`);
  return { errorHandling: 'abort' };
};
