import { randomUUID } from 'node:crypto'
import { request as newRequest, type Page } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'
import { SignInPage } from './pages/SignInPage.ts'

type SessionResponse = components['schemas']['SessionResponse']
type MatchRequest = components['schemas']['MatchRequest']

// The administrator, signed in by the `empty` project, holds
// `matches.view`, `matches.create` and `matches.score`.
test.use({ storageState: administratorState })

// How far the page scrolls sideways: 0 when everything fits.
const sideways = (page: Page) =>
  page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')

// Sends the match a board with `games`, encoded by the app's own encoder,
// which the dev server serves.
async function pushBoard(page: Page, match: MatchRequest, games: [number, number][]) {
  const status = await page.evaluate(
    async ({ match, games, modules }) => {
      const { encodePayload } = await import(modules.result)
      const { hex } = await import(modules.bytes)
      const payload = encodePayload(Math.floor(Date.now() / 1000), {
        match: match.id,
        bestOf: match.best_of,
        rated: match.rated,
        players: match.players,
        games,
        ending: 'completed',
        replaces: null,
      })
      const response = await fetch(`/api/v1/matches/${match.id}/boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: hex(payload) }),
      })
      return response.status
    },
    { match, games, modules: { result: '/src/signing/result.ts', bytes: '/src/signing/bytes.ts' } },
  )
  expect(status, 'the API took the board').toBeLessThan(300)
}

// "A vs B" of both matches, which this run's new guest plays.
let vs = ''

// One guest for the whole file, because the suite stays under the guest
// account limit.
test.beforeAll(async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, storageState: administratorState })
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player

  // A context without the administrator's cookies, which the file's
  // storageState would otherwise give it.
  const guest = await newRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const opponent = ((await (
    await guest.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
  ).json()) as SessionResponse).data.account.player
  await guest.dispose()

  vs = `${me.display_name} vs ${opponent.display_name}`
  const make = async (bestOf: MatchRequest['best_of']) => {
    const match: MatchRequest = {
      id: randomUUID(),
      best_of: bestOf,
      rated: false,
      players: [me.id, opponent.id],
    }
    const made = await page.request.post('/api/v1/matches', { data: match })
    expect(made.status(), `the API made the match: ${await made.text()}`).toBe(201)
    return match
  }
  await make(5)
  await pushBoard(page, await make(3), [[11, 7], [4, 6]])

  await page.close()
})

// A phone, just above the 900px breakpoint where the sidebar is tightest,
// and a laptop.
for (const width of [390, 920, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('the Matches page and a match fit without scrolling sideways', async ({ page }) => {
      await page.goto('/matches')

      // Newest first: the match with a board, then the one nobody scored.
      const matches = page.getByRole('link', { name: vs })
      await expect(matches).toHaveCount(2)
      await expect(page.getByText('Not started').first()).toBeVisible()
      await expect(page.getByRole('table')).toHaveCount(width < 900 ? 0 : 1)
      expect(await sideways(page)).toBe(0)

      await matches.first().click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(vs)
      await expect(page.getByText('Game 2', { exact: true })).toBeVisible()
      expect(await sideways(page)).toBe(0)
    })
  })
}
