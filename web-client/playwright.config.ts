import { defineConfig, devices } from '@playwright/test'

// Set by compose.dev.yaml: web-client's production build, served by the
// web-client-preview service. Run this suite with ./bin/mise run web-client:e2e.
const baseURL = process.env.BASE_URL
if (!baseURL) {
  throw new Error('BASE_URL is not set; run ./bin/mise run web-client:e2e')
}

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
