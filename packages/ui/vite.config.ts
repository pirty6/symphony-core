import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { symphonyPlugin } from './server/plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), symphonyPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', '**/*.integration.test.?(c|m)[jt]s?(x)'],
    exclude: ['node_modules', 'e2e/**'],
  },
})
