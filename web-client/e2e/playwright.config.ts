import { defineConfig, devices } from '@playwright/test'

// web-client's own browser suite: what only a real browser can show about the
// production build by itself, such as opening with no connection (the service
// worker) and what installing needs. It drives `vite preview` serving a build
// (web-client-preview) and needs no other app; how the build is hosted and
// how it reaches the api is the cross-app suite's (../../e2e). Run it with
// ./bin/mise run web-client:e2e.
//
// Set by compose.dev.yaml. The runner shares web-client-preview's network, so
// the app is on localhost: a secure context, where service workers run.
const baseURL = process.env.BASE_URL
if (!baseURL) {
  throw new Error('BASE_URL is not set; run ./bin/mise run web-client:e2e')
}

export default defineConfig({
  testDir: './tests',
  forbidOnly: !!process.env.CI,
  retries: 0,
  // One build is served at a time, and some tests deploy another
  // (pages/deployment.ts), so the tests run one after another.
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
