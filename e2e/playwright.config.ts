import { defineConfig, devices } from '@playwright/test'

const NGINX_PORT = process.env.E2E_NGINX_PORT ?? '18080'
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${NGINX_PORT}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
