import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 5174)
const baseURL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  expect: {
    // Allow a small ratio of pixels to differ between captures so AA
    // jitter on text rendering doesn't fail the screenshot tests.
    toHaveScreenshot: { maxDiffPixelRatio: 0.05 },
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // CI serves the production build via `vite preview` to avoid first-request
    // JIT-compile latency from the dev server, which causes intermittent
    // timeouts on cold runners. Local runs keep `vite dev` for fast iteration.
    command: process.env.CI
      ? `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`
      : `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
    env: {
      // Disable MSW so Playwright's page.route can intercept API calls instead.
      VITE_ENABLE_MSW: 'false',
    },
  },
})
