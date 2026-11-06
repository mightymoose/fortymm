import { request as newRequest } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'
import { NewMatchPage } from './pages/NewMatchPage.ts'

type SessionResponse = components['schemas']['SessionResponse']

// The administrator, whom the `empty` project signed in, may create
// matches.
test.use({ storageState: administratorState })

// Makes a match against the real API with another guest's player, found by
// search, and opens its scores.
test('makes a match against a player found by search, and opens its scores', async ({
  page,
  baseURL,
}) => {
  const other = await newRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const opponent = ((await (
    await other.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
  ).json()) as SessionResponse).data.account.player
  await other.dispose()

  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await expect(newMatch.title).toHaveText('New match')
  await newMatch.pickBySearch(opponent.display_name)
  await page.getByRole('radio', { name: '3 Short' }).click()
  await newMatch.startButton.click()

  // The fragment carries the match, so its scores open with no network.
  await expect(page).toHaveURL(/\/matches\/[0-9a-f-]{36}\/scores\/game\/1\/edit#.+$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Game 1')
  const games = page.getByRole('navigation', { name: 'Games' }).getByRole('listitem')
  await expect(games).toHaveCount(3)

  // A reload reads the match from the fragment alone, and asks the API
  // nothing about it.
  const matchRequests: string[] = []
  await page.route('**/api/v1/matches/**', (route) => {
    matchRequests.push(route.request().url())
    return route.abort()
  })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Game 1')
  await expect(games).toHaveCount(3)
  expect(matchRequests).toEqual([])
})
