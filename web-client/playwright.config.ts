import { defineConfig, devices } from '@playwright/test'

// Runs in the `playwright` Compose service, which shares the `dev` service's
// network, so the Vite dev server started there is on localhost.
// https://playwright.dev/docs/test-configuration
export default defineConfig({
  testDir: './e2e',
  // The post-deploy suite, run by playwright.deployed.config.ts.
  testIgnore: '**/deployed/**',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    // Always record a trace; CI uploads test-results/ so it can be opened
    // with `npx playwright show-trace` or https://trace.playwright.dev.
    trace: 'on',
  },
  projects: [
    // The empty Matches page needs a database with no match, so this runs
    // before every spec that makes one.
    { name: 'empty', testMatch: 'matches-empty.spec.ts', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      testIgnore: ['**/deployed/**', 'matches-empty.spec.ts'],
      dependencies: ['empty'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
