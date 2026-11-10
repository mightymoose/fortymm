import { defineConfig, devices } from '@playwright/test'

// The cross-app suite: only tests that need two or more apps running together.
// A test one app can prove alone belongs in that app's own suite
// (web-client/e2e/, api/e2e/). Run it with ./bin/mise run e2e.
//
// When the first cross-app journey lands, compose.dev.yaml sets BASE_URL to
// the web client that talks to the api, and this config passes it on as
// `use.baseURL`.
export default defineConfig({
  testDir: './tests',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
