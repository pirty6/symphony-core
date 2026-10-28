import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 5180)
// Runs made by the tests go to a throwaway folder, never to your saved runs.
const runsDir = mkdtempSync(join(tmpdir(), 'symphony-e2e-runs-'))

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
    port,
    // A fresh server, so the runs folder below is the one in use.
    reuseExistingServer: false,
    timeout: 60_000,
    env: { SYMPHONY_DEMO_DELAY_MS: '5', SYMPHONY_RUNS_DIR: runsDir },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
