import { defineConfig, devices } from '@playwright/test'

// The cross-app suite: what can fail only because of how the apps are served
// or connected, such as the hosting in front of the web client. Anything one
// app can prove by itself belongs in that app's own validate. Run it with
// ./bin/mise run e2e.
//
// Set by compose.dev.yaml: web-client's production build, served by
// web-client-hosting (a stand-in for the real hosting).
const baseURL = process.env.BASE_URL
if (!baseURL) {
  throw new Error('BASE_URL is not set; run ./bin/mise run e2e')
}

export default defineConfig({
  testDir: './tests',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // WebCrypto, which the web client signs with, exists only in a secure
        // context. The production hosting is https; the stand-in serves plain
        // http on the stack's network, so the browser is told to treat that
        // one origin as secure. Only full Chromium honours the switch, not
        // the headless shell Playwright uses by default.
        channel: 'chromium',
        launchOptions: {
          args: [`--unsafely-treat-insecure-origin-as-secure=${baseURL}`],
        },
      },
    },
  ],
})
