import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { newPerson } from './pages/SignInPage.ts'

// The mock provider answers 405 to Auth0's logout path, so this stands in for
// Auth0, which sends the browser on to returnTo.
async function answerLogout(page: Page) {
  await page.route('http://oidc:8080/default/v2/logout?**', (route) =>
    route.fulfill({
      status: 302,
      headers: { Location: new URL(route.request().url()).searchParams.get('returnTo')! },
    }),
  )
}

test('signs in from the account menu, signs out, then plays as a new guest account', async ({
  homePage,
  signInPage,
  signedOutPage,
  page,
  baseURL,
}) => {
  await answerLogout(page)
  const ann = newPerson('ann')
  const registered = homePage.keyRegistered()
  await homePage.goto()
  await registered
  const guest = await signInPage.account()
  expect(guest.kind).toBe('guest')
  const kid = await homePage.storedKeyId()
  expect(await signInPage.signingKeys()).toEqual([
    expect.objectContaining({ id: kid, signed_out_at: null, revoked_at: null }),
  ])

  await homePage.fromAccountMenu('Sign in')
  await signInPage.completeSignIn(ann)
  await expect(page).toHaveURL(new URL('/', baseURL).href)

  await expect(homePage.avatar(guest.player.display_name)).toBeVisible()
  await homePage.accountButton.click()
  await expect(homePage.accountMenu).toContainText(ann.email)
  expect(await signInPage.account()).toMatchObject({
    id: guest.id,
    kind: 'verified',
    email: ann.email,
    player: guest.player,
  })

  const logout = page.waitForRequest('**/api/v1/auth/logout')
  await homePage.accountMenu.getByRole('menuitem', { name: 'Sign out' }).click()

  await expect(signedOutPage.title).toHaveText('You’re signed out')
  expect(page.url()).toBe(new URL('/signed-out', baseURL).href)
  expect((await logout).postDataJSON()).toEqual({ signing_key_id: kid })
  expect(await homePage.storedKeyId()).toBeNull()

  const nextRegistered = homePage.keyRegistered()
  await signedOutPage.guestLink.click()

  // The menu shows once the page's own session has started.
  await expect(homePage.accountButton).toBeVisible()
  const next = await signInPage.account()
  expect(next.kind).toBe('guest')
  expect(next.id).not.toBe(guest.id)
  await nextRegistered
  const nextKid = await homePage.storedKeyId()
  expect(nextKid).not.toBe(kid)
  expect((await signInPage.signingKeys()).map((key) => key.id)).toEqual([nextKid])
})

test('asks a guest before it signs out from the account menu', async ({
  homePage,
  signInPage,
  signedOutPage,
  page,
  baseURL,
}) => {
  await answerLogout(page)
  await homePage.goto()
  const guest = await signInPage.account()

  await homePage.fromAccountMenu('Sign out')
  await expect(homePage.guestSignOutDialog).toContainText(
    `${guest.player.display_name} stays behind`,
  )
  await homePage.guestSignOutDialog.getByRole('button', { name: 'Sign out' }).click()

  await expect(signedOutPage.title).toHaveText('You’re signed out')
  expect(page.url()).toBe(new URL('/signed-out', baseURL).href)
  expect((await signInPage.account()).id).not.toBe(guest.id)
})

test('signs in again after sign-out to the same account and player', async ({
  homePage,
  signInPage,
  signedOutPage,
  page,
  baseURL,
}) => {
  await answerLogout(page)
  const ann = newPerson('ann')
  await homePage.goto()
  await homePage.fromAccountMenu('Sign in')
  await signInPage.completeSignIn(ann)
  await expect(page).toHaveURL(new URL('/', baseURL).href)
  const anns = await signInPage.account()
  await homePage.fromAccountMenu('Sign out')
  await expect(signedOutPage.title).toHaveText('You’re signed out')

  await signedOutPage.signInLink.click()
  await signInPage.completeSignIn(ann)

  // Sign-in from no session starts no guest account, so there's no new
  // player to adopt.
  await expect(page).toHaveURL(new URL('/', baseURL).href)
  await expect(homePage.avatar(anns.player.display_name)).toBeVisible()
  expect(await signInPage.account()).toEqual(anns)
  expect((await signInPage.players()).map((player) => player.id)).toEqual([anns.player.id])
})
