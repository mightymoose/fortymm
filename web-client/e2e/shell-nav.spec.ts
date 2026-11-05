import { expect, test } from './fixtures.ts'

// The migration makes this email's account an administrator, which holds
// `matches.view`, `players.view` and `matches.create`.
const administrator = { sub: 'e2e|mightymoose', email: 'mightymoose@fortymm.com' }

test('an administrator opens Matches and Players from the sidebar', async ({ homePage, signInPage }) => {
  await signInPage.signIn(administrator, { returnTo: '/' })
  await expect(homePage.navLink('New match')).toHaveCount(0)
  await expect(homePage.pageNewMatchLink).toBeVisible()

  await homePage.navLink('Matches').click()
  await expect(homePage.title).toHaveText('Matches')

  await homePage.navLink('Players').click()
  await expect(homePage.title).toHaveText('Players')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('New match is in the tab bar, not on Home', async ({ homePage, signInPage }) => {
    await signInPage.signIn(administrator, { returnTo: '/' })

    await expect(homePage.nav.getByRole('link')).toHaveText(['Home', 'Matches', 'Players', 'New match'])
    await expect(homePage.pageNewMatchLink).toHaveCount(0)

    await homePage.navLink('New match').click()
    await expect(homePage.title).toHaveText('New match')
  })
})
