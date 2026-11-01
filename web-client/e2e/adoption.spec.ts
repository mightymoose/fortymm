import { expect, test } from './fixtures.ts'
import { newPerson } from './pages/SignInPage.ts'

// What a sign-in does with the guest's player, against the real API and the
// mock provider. No player has played yet, so no sign-in asks "Is this you?".
// Each Home load without a session starts one guest account, so this file
// starts three.

test('a guest’s first sign-in keeps its player and asks nothing (VerifyInPlace)', async ({
  homePage,
  signInPage,
  page,
  baseURL,
}) => {
  await homePage.goto()
  const guest = await signInPage.account()

  await signInPage.signIn(newPerson('ann'), { returnTo: '/' })

  // With a question open, the app would replace the URL with /review-players.
  await expect(page).toHaveURL(new URL('/', baseURL).href)
  await expect(homePage.avatar(guest.player.display_name)).toBeVisible()
  await expect(homePage.reminder).toBeHidden()
  expect(await signInPage.account()).toMatchObject({
    id: guest.id,
    kind: 'verified',
    player: guest.player,
  })
})

test('a guest that signs in to an account plays as the account’s player (AdoptGuest)', async ({
  homePage,
  signInPage,
  page,
  baseURL,
}) => {
  const ann = newPerson('ann')
  await homePage.goto()
  await signInPage.signIn(ann, { returnTo: '/' })
  // Home's own POST /v1/session sets Ann's cookie again. Wait for it, or it
  // can land after forgetSession() and the next page load resumes Ann.
  await homePage.title.waitFor()
  const anns = await signInPage.account()

  await signInPage.forgetSession()
  await homePage.goto()
  const guest = await signInPage.account()
  await signInPage.signIn(ann, { returnTo: '/' })

  await expect(page).toHaveURL(new URL('/', baseURL).href)
  await expect(homePage.avatar(anns.player.display_name)).toBeVisible()
  await expect(homePage.reminder).toBeHidden()
  expect((await signInPage.players()).map((player) => player.id)).toEqual([anns.player.id])
  expect((await signInPage.account()).player).toEqual(anns.player)
  expect(guest.player.id).not.toBe(anns.player.id)
})
