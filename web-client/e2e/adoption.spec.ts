import { expect, test } from './fixtures.ts'
import { newPerson } from './pages/SignInPage.ts'

// "Is this you?" after a sign-in, against the real API and the mock
// provider. Each Home load without a session starts one guest account, so
// this file starts four.

test('a new email asks about the guest’s own player (VerifyInPlace)', async ({
  homePage,
  signInPage,
}) => {
  await homePage.goto()
  const guest = await signInPage.account()

  await signInPage.signIn(newPerson('ann'), { returnTo: '/' })

  await expect(homePage.reviewTitle).toHaveText(`Who is ${guest.player.display_name}?`)
  await homePage.review.getByRole('button', { name: 'Review later' }).click()
  await expect(homePage.reminder).toHaveText('1 player to review')

  await homePage.page.reload()

  await expect(homePage.reminder).toHaveText('1 player to review')
  await expect(homePage.review).toBeHidden()
})

test('each sign-in from a guest asks about its player, and answers stay answered (AdoptGuest)', async ({
  homePage,
  signInPage,
}) => {
  const ann = newPerson('ann')

  // A new person's first sign-in from a guest keeps that guest account, so
  // its own player is the first question.
  await homePage.goto()
  const first = (await signInPage.account()).player.display_name
  await signInPage.signIn(ann, { returnTo: '/' })
  await expect(homePage.reviewTitle).toHaveText(`Who is ${first}?`)
  await homePage.answer('This is me')
  await expect(homePage.page.getByText(`${first} is your player now.`)).toBeVisible()
  await expect(homePage.avatar(first)).toBeVisible()

  await signInPage.forgetSession()
  await homePage.goto()
  const second = (await signInPage.account()).player.display_name
  await signInPage.signIn(ann, { returnTo: '/' })
  await expect(homePage.reviewTitle).toHaveText(`Who is ${second}?`)
  await homePage.answer('This is me')
  await expect(homePage.page.getByText(`${second} merged into ${first}, your player.`)).toBeVisible()
  await expect(homePage.avatar(first)).toBeVisible()

  await homePage.page.reload()
  await homePage.title.waitFor()
  await expect(homePage.review).toBeHidden()
  await expect(homePage.reminder).toBeHidden()

  await signInPage.forgetSession()
  await homePage.goto()
  const third = (await signInPage.account()).player.display_name
  await signInPage.signIn(ann, { returnTo: '/' })
  await expect(homePage.reviewTitle).toHaveText(`Who is ${third}?`)
  await homePage.answer('Remove from my account')
  await expect(homePage.page.getByText(`${third} removed from your account.`)).toBeVisible()

  await homePage.page.reload()
  await homePage.title.waitFor()
  await expect(homePage.review).toBeHidden()
  await expect(homePage.reminder).toBeHidden()
  const account = await signInPage.account()
  expect(account).toMatchObject({ kind: 'verified', email: ann.email })
  expect(account.player.display_name).toBe(first)
})
