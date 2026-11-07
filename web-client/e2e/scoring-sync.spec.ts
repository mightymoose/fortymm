import { randomUUID } from 'node:crypto'
import { request as newRequest, type Locator } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'
import { SignInPage } from './pages/SignInPage.ts'

type SessionResponse = components['schemas']['SessionResponse']
type MatchRequest = components['schemas']['MatchRequest']

// The administrator holds `matches.score`, so an API match's board syncs.
test.use({ storageState: administratorState, viewport: { width: 390, height: 844 } })

test('a game stuck offline is the grey offline slot, with no amber', async ({ page, context, baseURL }) => {
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player
  // A context without the administrator's cookies, which the file's
  // storageState would otherwise give it.
  const guest = await newRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const opponent = ((await (
    await guest.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
  ).json()) as SessionResponse).data.account.player
  await guest.dispose()
  const match: MatchRequest = { id: randomUUID(), best_of: 5, rated: false, players: [me.id, opponent.id] }
  const made = await page.request.post('/api/v1/matches', { data: match })
  expect(made.status(), `the API made the match: ${await made.text()}`).toBe(201)
  // The scoring page reads the match from its fragment, made with the
  // app's own encoder, which the dev server serves.
  const hash = await page.evaluate(
    async ({ match, modules }) => {
      const { draftHash } = await import(modules.fragment)
      const { apiMatch } = await import(modules.matches)
      const opened = apiMatch(match.id, match.best_of, match.rated, match.players)
      return draftHash(opened, [], null, Math.floor(Date.now() / 1000))
    },
    { match, modules: { fragment: '/src/scoring/fragment.ts', matches: '/src/scoring/matches.ts' } },
  )

  await page.goto(`/matches/${match.id}/scores/game/1/edit#${hash}`)
  const strip = page.getByRole('navigation', { name: 'Games' })
  const slot = (game: number) => strip.locator('.score-slot', { hasText: `Game ${game}` })
  const style = (locator: Locator, property: string) =>
    locator.evaluate(
      (element, property) => element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(property),
      property,
    )

  const inputs = page.getByRole('textbox')
  // The dev server serves the page's modules one by one, so it goes
  // offline only once they have all loaded.
  await expect(inputs).toHaveCount(2)
  await context.setOffline(true)
  await inputs.nth(0).fill('11')
  await inputs.nth(1).fill('7')
  await page.getByRole('button', { name: 'Save game 1' }).click()

  const note = strip.getByRole('status')
  await expect(note).toHaveText('Offline. Saved on this device.')
  await expect(slot(1)).toHaveCSS('border-top-style', 'dashed')
  // Game 1 was the current game, so its accent edge fades out first.
  const usualBorder = await style(slot(3), 'border-top-color')
  await expect(slot(1), 'the stuck edge keeps the usual border colour').toHaveCSS('border-top-color', usualBorder)
  const labelGrey = await style(strip.getByText('Games', { exact: true }), 'color')
  await expect(note, 'the note is the Games label’s grey').toHaveCSS('color', labelGrey)
  await test.info().attach('offline strip', { body: await strip.screenshot(), contentType: 'image/png' })

  await context.setOffline(false)
  await expect(slot(1)).toHaveCSS('border-top-style', 'solid')
})
