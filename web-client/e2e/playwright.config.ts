import { defineConfig, devices } from '@playwright/test'

// web-client's own browser suite: what only a real browser can show about the
// production build by itself, such as opening with no connection (the service
// worker) and what installing needs. It drives `vite preview` serving a build
// (web-client-preview) and needs no other app; how the build is hosted and
// how it reaches the api is the cross-app suite's (../../e2e). Run it with
// ./bin/mise run web-client:e2e.
//
// Set by compose.dev.yaml. The runner shares web-client-preview's network, so
// the app is on localhost: a secure context, where service workers run.
const baseURL = process.env.BASE_URL
if (!baseURL) {
  throw new Error('BASE_URL is not set; run ./bin/mise run web-client:e2e')
}

export default defineConfig({
  testDir: './tests',
  forbidOnly: !!process.env.CI,
  retries: 0,
  // One build is served at a time: each test deploys its own before it
  // starts (pages/test.ts), and some deploy another mid-test, so the tests
  // run one after another.
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  // Screenshot baselines (design-system.spec.ts), committed beside the tests:
  // tests/__screenshots__/<spec file>/<data-testid>.png. No platform or
  // project in the name: the suite only runs in its own container (dev/e2e,
  // the pinned Playwright image: one Linux, one Chromium, one set of system
  // fonts, and the app's own font files), so there is one baseline per
  // picture, the same in CI and on a laptop. A missing baseline fails in CI;
  // elsewhere the run writes it and passes, so look at it before committing
  // it. Write them again with ./bin/mise run web-client:e2e -- --update-snapshots.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  expect: {
    toHaveScreenshot: {
      // Transitions finished, no caret: the picture never depends on when
      // it was taken.
      animations: 'disabled',
      caret: 'hide',
      // Up to 0.01% of a picture's pixels may differ. Measured: none differ
      // between two runs, nor between the container on an arm64 laptop and
      // on CI's amd64 (with the select's chevron drawn off the pixel grid's
      // ties, controls-tab/Select.css). So this is headroom of about one pixel in a
      // matrix cell and a dozen in a matrix row, well under the smallest
      // change seen to fail: a field's corners 2px rounder, 12 pixels in a
      // cell. A larger allowance would let a large picture hide a change:
      // at 0.1%, a field label set bold passed in its 384x126 example.
      // What no allowance changes: Playwright's comparator (pixelmatch)
      // never counts pixels it takes for anti-aliasing, so a change of
      // about a pixel at a curved edge (a radio's dot 10px to 8px, a
      // checkbox's corner 4px to 2px) passes; 10px to 6px fails.
      maxDiffPixelRatio: 0.0001,
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
