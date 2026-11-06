import type { Page } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'

// The migration makes this email's account an administrator, which holds
// `matches.view` and `matches.create`.
const administrator = { sub: 'e2e|mightymoose', email: 'mightymoose@fortymm.com' }

const sideways = (page: Page) =>
  page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')

// Runs in the `empty` project, before every spec that makes a match, and
// saves the administrator's cookies for them. Only a fresh database has no
// match. GitHub CI starts from one, so there a match fails the test. A local
// run whose database kept matches skips it.
test('the Matches page says there are no matches yet, on a phone and a laptop', async ({
  page,
  signInPage,
}) => {
  await signInPage.signIn(administrator, { returnTo: '/' })
  await page.context().storageState({ path: administratorState })
  const listed: components['schemas']['MatchesResponse'] = await (
    await page.request.get('/api/v1/matches')
  ).json()
  const held = listed.data.length
  if (process.env.CI) {
    expect(held, 'CI starts from a fresh database, which holds no match').toBe(0)
  }
  test.skip(
    held > 0,
    `The database holds ${held} matches, so the Matches page can't be empty. Run \`docker compose down -v\` to start from a fresh one.`,
  )

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/matches')
    const main = page.getByRole('main')
    await expect(main.getByText('No matches yet')).toBeVisible()
    await expect(main.getByText('Start one with New match, and it shows here.')).toBeVisible()
    await expect(main.getByRole('link', { name: 'New match' })).toHaveAttribute('href', '/matches/new')
    await expect(page.getByRole('table')).toHaveCount(0)
    expect(await sideways(page)).toBe(0)
  }
})
