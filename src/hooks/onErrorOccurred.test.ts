import { onErrorOccurred } from './onErrorOccurred';

const baseInput = {
  sessionId: 'test-session',
  timestamp: new Date(),
  workingDirectory: '/tmp',
  recoverable: false,
};

describe('onErrorOccurred', () => {
  it('returns abort error handling', async () => {
    const result = await onErrorOccurred({
      ...baseInput,
      error: 'something broke',
      errorContext: 'tool_execution',
    });

    expect(result).toEqual({ errorHandling: 'abort' });
  });

  it('logs the error to stderr', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();

    await onErrorOccurred({
      ...baseInput,
      error: 'timeout',
      errorContext: 'system',
    });

    expect(spy).toHaveBeenCalledWith('Error in system: timeout');
    spy.mockRestore();
  });
});
