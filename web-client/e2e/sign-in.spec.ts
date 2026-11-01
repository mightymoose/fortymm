import { expect, test } from './fixtures.ts'
import { newPerson, SignInPage } from './pages/SignInPage.ts'

// One test per row of the sign-in outcome table, against the mock provider.
// Each test starts one or two guest accounts. The API allows 30 a minute
// from one network, and the rest of the suite shares that budget.

test('a guest with a new email keeps its account (VerifyInPlace)', async ({ signInPage }) => {
  const ann = newPerson('ann')
  const guest = await signInPage.account()

  const returned = await signInPage.signIn(ann)

  expect(returned.search).toBe('?signed_in=1')
  const account = await signInPage.account()
  expect(account).toMatchObject({ id: guest.id, kind: 'verified', email: ann.email })
})

test('the account that owns the identity stays signed in (AlreadySignedIn)', async ({
  signInPage,
}) => {
  const ann = newPerson('ann')
  await signInPage.signIn(ann)
  const before = await signInPage.account()

  const returned = await signInPage.signIn(ann)

  expect(returned.search).toBe('?signed_in=1')
  expect(await signInPage.account()).toMatchObject({
    id: before.id,
    kind: 'verified',
    email: ann.email,
  })
})

test('a guest signing in to another account joins it (AdoptGuest)', async ({ signInPage }) => {
  const bob = newPerson('bob')
  await signInPage.signIn(bob)
  const bobs = await signInPage.account()
  await signInPage.forgetSession()
  const guest = await signInPage.account()
  expect(guest.kind).toBe('guest')

  const returned = await signInPage.signIn(bob)

  expect(returned.search).toBe('?signed_in=1')
  expect(await signInPage.account()).toMatchObject({
    id: bobs.id,
    kind: 'verified',
    email: bob.email,
  })
})

test('a verified account signing in as another switches to it (SwitchAccount)', async ({
  signInPage,
}) => {
  const bob = newPerson('bob')
  const ann = newPerson('ann')
  await signInPage.signIn(bob)
  const bobs = await signInPage.account()
  await signInPage.forgetSession()
  await signInPage.signIn(ann)
  const anns = await signInPage.account()

  const returned = await signInPage.signIn(bob)

  expect(returned.search).toBe('?signed_in=1')
  const account = await signInPage.account()
  expect(account).toMatchObject({ id: bobs.id, kind: 'verified', email: bob.email })
  expect(account.id).not.toBe(anns.id)
})

test('a verified account with a new email reaches a new account (CreateAccount)', async ({
  signInPage,
}) => {
  const ann = newPerson('ann')
  const annAtWork = newPerson('ann-work')
  await signInPage.signIn(ann)
  const anns = await signInPage.account()

  const returned = await signInPage.signIn(annAtWork)

  expect(returned.search).toBe('?signed_in=1')
  const account = await signInPage.account()
  expect(account).toMatchObject({ kind: 'verified', email: annAtWork.email })
  expect(account.id).not.toBe(anns.id)
})

// #134: each sign-in replaces the browser's session. A sign-in that another
// tab's sign-in overtook must say it failed, not land in that tab's account.
for (const browser of ['guest', 'verified'] as const) {
  test(`a ${browser} browser's sign-in that another tab overtook shows an error`, async ({
    page,
    signInPage,
  }) => {
    if (browser === 'verified') await signInPage.signIn(newPerson('ann'))
    else await signInPage.account()
    await signInPage.startSignIn({ returnTo: '/' })
    const otherTab = new SignInPage(await page.context().newPage())
    const bob = newPerson('bob')
    await otherTab.signIn(bob)

    await signInPage.completeSignIn(newPerson('carol'))

    await page.waitForURL((url) => url.pathname === '/')
    await expect(page.getByRole('alert', { name: 'Sign-in didn’t work' })).toBeVisible()
    expect(await signInPage.account()).toMatchObject({ kind: 'verified', email: bob.email })
  })
}
