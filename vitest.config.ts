import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'packages'],
    // Tests never publish runs to the home folder (src/runtime/live.ts); a test sets its own.
    // nor keep their files in your home folder (src/runtime/state.ts): the old layout, in each
    // test's own temporary workspace; a test of the new layout sets its own SYMPHONY_HOME.
    env: {
      SYMPHONY_LIVE: 'off',
      SYMPHONY_STATE: 'workspace',
      SYMPHONY_HOME: join(tmpdir(), 'symphony-test-home'),
    },
    // Process start and git are several times slower on Windows runners.
    ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
  },
});
