import { defineConfig, devices } from '@playwright/test'

// Runs in the web-client container (see mise-tasks/web-client/e2e and mise-tasks/verify). Unless
// E2E_BASE_URL is set, Playwright starts its own Vite dev server inside that container.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'

export default defineConfig({
  testDir: './e2e',
  // The dev server has no service worker: e2e/offline/ runs against a build (playwright.offline.config.ts).
  testIgnore: 'offline/**',
  // One screenshot per name for every target and platform: the design system specs check the app
  // against the reference's screenshots (see e2e/design-system/design-system.spec.ts).
  snapshotPathTemplate: '{testDir}/{testFileDir}/__screenshots__/{arg}{ext}',
  // Never write a missing screenshot as a side effect: an app run would make itself the baseline.
  // Baselines come only from the reference (./bin/mise run web-client:screenshots).
  updateSnapshots: 'none',
  // Pixel-perfect: any colour difference in any pixel fails (the default lets near colours pass).
  expect: { toHaveScreenshot: { threshold: 0 } },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // No browser on the host to open the HTML report in; it is written to playwright-report/.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Point at a running dev server (the verify task sets E2E_BASE_URL), or start one here.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run dev', url: baseURL, reuseExistingServer: !process.env.CI },
})
