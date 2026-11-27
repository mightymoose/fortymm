import { defineConfig, devices } from '@playwright/test'

// The offline tests (e2e/offline/): the service worker exists only in a production build, so these
// run against `vite build` + `vite preview` inside the web-client container, not the dev server
// the other e2e tests use. Run via ./bin/mise run web-client:e2e-offline (and verify).
const baseURL = 'http://localhost:4173'

export default defineConfig({
  testDir: './e2e/offline',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // No browser on the host to open the HTML report in.
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/offline' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: baseURL,
    // The build typechecks first, so give it time.
    timeout: 180_000,
  },
})
