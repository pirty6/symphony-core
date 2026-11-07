import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 5180)
// Runs made by the tests go to a throwaway folder, never to your saved runs.
const runsDir = mkdtempSync(join(tmpdir(), 'symphony-e2e-runs-'))
// The studio lists the runs in this folder: keep the machine's own live runs (and CLI runs) out of it.
// Kept in the environment so the test workers, which load this file again, share the folder.
const liveDir = (process.env.SYMPHONY_E2E_LIVE_DIR ??= mkdtempSync(join(tmpdir(), 'symphony-e2e-live-')))

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    viewport: { width: 1600, height: 950 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    // The API answering (not just the port open) means its cold first load is done.
    url: `http://localhost:${port}/api/patterns`,
    // A fresh server, so the runs folder below is the one in use.
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      SYMPHONY_DEMO_DELAY_MS: '5',
      SYMPHONY_RUNS_DIR: runsDir,
      SYMPHONY_LIVE_DIR: liveDir,
      // No discovery of the user's own MCP servers: the offline demo needs none.
      SYMPHONY_MCP: 'off',
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
