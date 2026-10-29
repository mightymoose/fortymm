import { expect, test } from './fixtures.ts'
import { newPerson } from './pages/SignInPage.ts'

// "Is this you?" after a sign-in, against the real API and the mock
// provider. Each Home load without a session starts one guest account, so
// this file starts four.

test('a new email asks about the guest’s own player, and the reminder reopens it (VerifyInPlace)', async ({
  homePage,
  playerReviewPage,
  signInPage,
}) => {
  await homePage.goto()
  const guest = await signInPage.account()

  await signInPage.signIn(newPerson('ann'), { returnTo: '/' })

  await expect(playerReviewPage.question).toHaveText('Is this you?')
  await expect(playerReviewPage.content).toContainText(
    `${guest.player.display_name} was used on this device before you signed in.`,
  )
  await playerReviewPage.reviewLater()
  await expect(homePage.reminder).toHaveText('1 player to review')

  await homePage.page.reload()

  await expect(homePage.reminder).toHaveText('1 player to review')
  expect(new URL(homePage.page.url()).pathname).toBe('/')

  await homePage.reviewLink.click()
  await playerReviewPage.answer('no')

  await expect(
    homePage.page.getByText(`${guest.player.display_name} added to players you manage.`),
  ).toBeVisible()
  await expect(homePage.reminder).toBeHidden()
})

test('each sign-in from a guest asks about its player, and answers stay answered (AdoptGuest)', async ({
  homePage,
  playerReviewPage,
  signInPage,
}) => {
  const ann = newPerson('ann')

  // A new person's first sign-in from a guest keeps that guest account, so
  // its own player is the first question.
  await homePage.goto()
  const first = (await signInPage.account()).player.display_name
  await signInPage.signIn(ann, { returnTo: '/' })
  await expect(playerReviewPage.question).toHaveText('Is this you?')
  await playerReviewPage.answer('yes')
  await expect(homePage.page.getByText(`${first} is your player now.`)).toBeVisible()
  await expect(homePage.avatar(first)).toBeVisible()

  await signInPage.forgetSession()
  await homePage.goto()
  const second = (await signInPage.account()).player.display_name
  await signInPage.signIn(ann, { returnTo: '/' })
  await expect(playerReviewPage.question).toHaveText('Is this you?')
  await playerReviewPage.answer('yes')
  await expect(homePage.page.getByText(`${second} merged into ${first}, your player.`)).toBeVisible()
  await expect(homePage.avatar(first)).toBeVisible()

  await homePage.page.reload()
  await homePage.title.waitFor()
  await expect(homePage.reminder).toBeHidden()

  await signInPage.forgetSession()
  await homePage.goto()
  const third = (await signInPage.account()).player.display_name
  await signInPage.signIn(ann, { returnTo: '/' })
  await expect(playerReviewPage.question).toHaveText('Is this you?')
  await playerReviewPage.answer('not_mine')
  await expect(homePage.page.getByText(`${third} removed from your account.`)).toBeVisible()

  await homePage.page.reload()
  await homePage.title.waitFor()
  await expect(homePage.reminder).toBeHidden()
  const account = await signInPage.account()
  expect(account).toMatchObject({ kind: 'verified', email: ann.email })
  expect(account.player.display_name).toBe(first)
})
