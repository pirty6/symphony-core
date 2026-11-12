import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { symphonyPlugin } from './server/plugin.ts'

const core = fileURLToPath(new URL('../../src/core', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), symphonyPlugin()],
  resolve: { alias: { '@core': core } },
  server: {
    fs: { allow: ['../..'] },
    // Names the studio may be reached by on your network (e.g. symphony.example.org), besides
    // localhost and IP addresses: SYMPHONY_STUDIO_HOSTS=name1,name2.
    allowedHosts: (process.env.SYMPHONY_STUDIO_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  },
  test: {
    globals: true,
    // Tests never read or publish the runs of other processes (src/runtime/live.ts).
    env: { SYMPHONY_LIVE: 'off', SYMPHONY_STATE: 'workspace' },
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'server/**/*.test.ts'],
    exclude: ['node_modules', 'e2e/**'],
  },
})
