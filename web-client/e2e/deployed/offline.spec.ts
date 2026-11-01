import { expect, test } from '../fixtures.ts'

// Both pages make no request, so offline they show only what the service
// worker serves.
test('serves the app offline once the service worker is installed', async ({
  context,
  page,
  designSystemPage,
  signedOutPage,
}) => {
  await designSystemPage.goto()
  // Strings, because the e2e tsconfig has no DOM types.
  await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
  // It takes no page over, so only a page loaded after it installed uses it.
  await page.reload()
  expect(await page.evaluate('!!navigator.serviceWorker.controller')).toBe(true)

  await context.setOffline(true)
  await designSystemPage.goto()
  await expect(designSystemPage.title).toHaveText('Design System')

  // A route this page never loaded, so its chunk comes from the precache.
  await page.goto('/signed-out')
  await expect(signedOutPage.title).toHaveText('You’re signed out')

  // /api/* navigations, such as sign-in, must reach the Worker, never the
  // app shell.
  await expect(page.goto('/api/v1/health')).rejects.toThrow('ERR_INTERNET_DISCONNECTED')
})
