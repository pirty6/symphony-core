import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'packages'],
    // Tests never publish runs to the home folder (src/runtime/live.ts); a test sets its own.
    env: { SYMPHONY_LIVE: 'off' },
    // Process start and git are several times slower on Windows runners.
    ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
  },
});
