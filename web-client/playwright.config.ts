import { defineConfig, devices } from '@playwright/test'

// Runs in the `playwright` Compose service, which shares the `dev` service's
// network, so the Vite dev server started there is on localhost.
// https://playwright.dev/docs/test-configuration
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    // Always record a trace; CI uploads test-results/ so it can be opened
    // with `npx playwright show-trace` or https://trace.playwright.dev.
    trace: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
