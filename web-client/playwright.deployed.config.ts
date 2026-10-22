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
    {
      name: 'chromium',
      testIgnore: 'ready.spec.ts',
      dependencies: ['ready'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
