import { expect, test } from '../fixtures.ts'
import { stubbedSession, stubSession } from './stubSession.ts'

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

// Offline, a page load can't start the session, so the signed-in pages show
// the account the last load saved. With nothing saved, they can't.
test('shows the signed-in pages offline with the saved session', async ({
  context,
  page,
  homePage,
}) => {
  test.setTimeout(60_000)
  const unstubSession = await stubSession(context)
  await homePage.goto()
  await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
  await page.reload()
  await expect(homePage.title).toHaveText('What’s coming, and when.')

  await unstubSession()
  await context.setOffline(true)
  await homePage.goto()
  await expect(homePage.title).toHaveText('What’s coming, and when.')
  await expect(homePage.accountButton).toContainText(
    stubbedSession.data.account.player.display_name,
  )

  await page.evaluate('localStorage.clear()')
  await page.reload()
  // The session request retries before the error page shows.
  await expect(homePage.title).toHaveText('Can’t reach FortyMM', { timeout: 20_000 })
})
