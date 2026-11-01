import { defineConfig, devices } from '@playwright/test'

// The post-deploy suite in e2e/deployed: checks that a deployment (a
// Cloudflare Preview or production) serves the app and forwards /api to the
// API. `mise run web-client:e2e-deployed` runs it with PLAYWRIGHT_BASE_URL set
// to DEPLOY_URL.
const baseURL = process.env.PLAYWRIGHT_BASE_URL
if (!baseURL) {
  throw new Error(
    'PLAYWRIGHT_BASE_URL is not set: point it at the deployment to check, e.g. https://fortymm.com',
  )
}

// Production keeps every account, and a check there must write nothing. So
// production gets only the health check. Against a Preview, app.spec.ts and
// offline.spec.ts answer the session themselves, so their page loads make no
// account. Only
// sign-in.spec.ts, which starts one, and session-limit.spec.ts start real
// ones.
const PRODUCTION_HOSTS = ['fortymm.com', 'www.fortymm.com']
const production = PRODUCTION_HOSTS.includes(new URL(baseURL).hostname)

export default defineConfig({
  testDir: './e2e/deployed',
  // Subdirectories of the main run's, so neither run wipes the other's
  // traces, and CI uploads both.
  outputDir: 'test-results/deployed',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report/deployed' }],
  ],
  use: {
    baseURL,
    trace: 'on',
  },
  projects: [
    // Waits for the deployment to answer before the other specs run.
    { name: 'ready', testMatch: 'ready.spec.ts' },
    ...(production
      ? []
      : [
          {
            name: 'chromium',
            testIgnore: ['ready.spec.ts', 'session-limit.spec.ts'],
            dependencies: ['ready'],
            use: { ...devices['Desktop Chrome'] },
          },
          // Last, because it spends this client's guest account budget. A
          // retry in the same minute would find the budget spent.
          {
            name: 'session-limit',
            testMatch: 'session-limit.spec.ts',
            dependencies: ['chromium'],
            retries: 0,
          },
        ]),
  ],
})
