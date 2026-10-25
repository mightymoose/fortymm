import { expect, test } from './fixtures.ts'
import { newPerson } from './pages/SignInPage.ts'

// One test per row of the sign-in outcome table, against the mock provider.
// Each test starts one or two guest accounts. The API allows 30 a minute
// from one network, and the rest of the suite shares that budget.

test('a guest with a new email keeps its account (VerifyInPlace)', async ({ signInPage }) => {
  const ann = newPerson('ann')
  const guest = await signInPage.account()

  const returned = await signInPage.signIn(ann)

  expect(returned.search).toBe('')
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

  expect(returned.search).toBe('')
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

  expect(returned.search).toBe('')
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

  expect(returned.search).toBe('')
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

  expect(returned.search).toBe('')
  const account = await signInPage.account()
  expect(account).toMatchObject({ kind: 'verified', email: annAtWork.email })
  expect(account.id).not.toBe(anns.id)
})
