import { expect, test } from '@playwright/test'

// PLACEHOLDER. Proves nothing about the apps. It keeps the cross-app stage
// (the `e2e` task, CI's second stage) running so the suite, its container and
// its CI job exist before the first test that needs the web client and the api
// together. Delete it when that first cross-app journey is written.
test('placeholder until the first cross-app journey', () => {
  expect(1).toBe(1)
})
