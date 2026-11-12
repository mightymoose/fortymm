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
    // Service workers run only in a secure context: https, or localhost. The
    // production hosting is https; the stand-in is plain http on the stack's
    // network, so tell Chromium to treat its origin as secure.
    launchOptions: {
      args: [
        `--unsafely-treat-insecure-origin-as-secure=${new URL(baseURL).origin}`,
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      // The full Chromium, not the headless shell, which ignores the flag
      // above, so service workers would not run.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
})
