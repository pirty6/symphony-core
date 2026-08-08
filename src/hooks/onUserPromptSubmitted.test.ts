import { onUserPromptSubmitted } from './onUserPromptSubmitted';

const baseInput = {
  sessionId: 'test-session',
  timestamp: new Date(),
  workingDirectory: '/tmp',
};

describe('onUserPromptSubmitted', () => {
  it('returns the prompt unmodified', async () => {
    const prompt = 'fix the bug in auth module';
    const result = await onUserPromptSubmitted({ ...baseInput, prompt });

    expect(result).toEqual({ modifiedPrompt: prompt });
  });

  it('handles long prompts without truncating the output', async () => {
    const prompt = 'a'.repeat(500);
    const result = await onUserPromptSubmitted({ ...baseInput, prompt });

    expect(result!.modifiedPrompt).toHaveLength(500);
  });

  it('logs the prompt with session ID and char count', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation();
    const prompt = 'x'.repeat(100);

    await onUserPromptSubmitted({ ...baseInput, prompt });

    expect(spy).toHaveBeenCalledWith(
      `[server] ─── onUserPromptSubmitted (session=test-session) ───`
    );
    expect(spy).toHaveBeenCalledWith(
      `  prompt (100 chars): ${'x'.repeat(100)}`
    );
    spy.mockRestore();
  });
});
