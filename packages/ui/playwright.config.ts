import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 5180)

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
    reuseExistingServer: true,
    timeout: 60_000,
    env: { SYMPHONY_DEMO_DELAY_MS: '5' },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
