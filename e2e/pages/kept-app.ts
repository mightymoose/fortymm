import type { Page } from '@playwright/test'

// The copy of the web client the browser keeps on the device (its service
// worker, web-client/offline/). After a first visit with a connection, wait
// for it before testing what happens without one: the worker takes control
// of the page once it has kept every file.
export async function waitUntilAppIsKept(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
}
