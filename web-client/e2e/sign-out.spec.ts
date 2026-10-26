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

test('signs in from the strip on Home, signs out, then plays as a new guest account', async ({
  homePage,
  signInPage,
  signedOutPage,
  page,
  baseURL,
}) => {
  await answerLogout(page)
  const ann = newPerson('ann')
  await homePage.goto()
  await expect(homePage.signInStrip).toContainText('Playing as a guest.')
  const guest = await signInPage.account()

  await homePage.signInLink.click()
  await signInPage.completeSignIn(ann)
  await homePage.review.getByRole('button', { name: 'Review later' }).click()

  await expect(homePage.signedInAs(ann.email)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
  expect(await signInPage.account()).toMatchObject({
    id: guest.id,
    kind: 'verified',
    email: ann.email,
  })

  await homePage.signOutButton.click()

  await expect(signedOutPage.title).toHaveText('You’re signed out')
  expect(page.url()).toBe(new URL('/signed-out', baseURL).href)

  await signedOutPage.guestLink.click()

  await expect(homePage.signInStrip).toContainText('Playing as a guest.')
  const next = await signInPage.account()
  expect(next.kind).toBe('guest')
  expect(next.id).not.toBe(guest.id)
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

  await homePage.accountButton.click()
  await homePage.accountMenu.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(homePage.guestSignOutDialog).toContainText(
    `${guest.player.display_name} stays behind`,
  )
  await homePage.guestSignOutDialog.getByRole('button', { name: 'Sign out' }).click()

  await expect(signedOutPage.title).toHaveText('You’re signed out')
  expect(page.url()).toBe(new URL('/signed-out', baseURL).href)
  expect((await signInPage.account()).id).not.toBe(guest.id)
})

test('signs in again after sign-out with no new player to review', async ({
  homePage,
  signInPage,
  signedOutPage,
  page,
}) => {
  await answerLogout(page)
  const ann = newPerson('ann')
  await homePage.goto()
  await homePage.signInLink.click()
  await signInPage.completeSignIn(ann)
  await homePage.review.getByRole('button', { name: 'Review later' }).click()
  await expect(homePage.reminder).toHaveText('1 player to review')
  const anns = await signInPage.account()
  await homePage.signOutButton.click()
  await expect(signedOutPage.title).toHaveText('You’re signed out')

  await signedOutPage.signInLink.click()
  await signInPage.completeSignIn(ann)
  await homePage.review.getByRole('button', { name: 'Review later' }).click()

  await expect(homePage.signedInAs(ann.email)).toBeVisible()
  // Only the first sign-in's guest player waits. Sign-in from no session
  // starts no guest account, so there's nothing new to adopt.
  await expect(homePage.reminder).toHaveText('1 player to review')
  expect((await signInPage.account()).id).toBe(anns.id)
})
