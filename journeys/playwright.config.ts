import { defineConfig, devices } from '@playwright/test'

// Whole-stack journeys: a real browser against the built web client on nginx (web-client-nginx,
// with its service worker) → api → core, reached on the compose network. Run by
// ./bin/mise run journeys:test and verify, which start the servers if needed and rebuild the
// web client first.
const baseURL = process.env.JOURNEYS_BASE_URL ?? 'http://web-client-nginx:5173'

export default defineConfig({
  testDir: './tests',
  testMatch: '*.journey.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // No browser on the host to open the HTML report in; it is written to playwright-report/.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Service workers need a secure context (https or localhost). The compose network serves
        // plain http under a service name, so tell Chromium to treat that one origin as secure.
        // Only full Chromium (new headless) honours the flag; the default headless shell ignores it.
        channel: 'chromium',
        launchOptions: { args: [`--unsafely-treat-insecure-origin-as-secure=${new URL(baseURL).origin}`] },
      },
    },
  ],
})
