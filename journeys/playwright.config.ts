import { defineConfig, devices } from '@playwright/test'

// Whole-stack journeys: a real browser against the running dev servers (web client → api → core),
// reached on the compose network. Run by ./bin/mise run journeys:test and verify, which start the
// servers if needed.
export default defineConfig({
  testDir: './tests',
  testMatch: '*.journey.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // No browser on the host to open the HTML report in; it is written to playwright-report/.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.JOURNEYS_BASE_URL ?? 'http://web-client:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
