import { expect, test } from './fixtures.ts'
import { newPerson } from './pages/SignInPage.ts'

test('signs in from the strip on Home, signs out, then plays as a new guest account', async ({
  homePage,
  signInPage,
  signedOutPage,
  page,
  baseURL,
}) => {
  // The mock provider answers 405 to Auth0's logout path, so this stands in
  // for Auth0, which sends the browser on to returnTo.
  await page.route('http://oidc:8080/default/v2/logout?**', (route) =>
    route.fulfill({
      status: 302,
      headers: { Location: new URL(route.request().url()).searchParams.get('returnTo')! },
    }),
  )
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
