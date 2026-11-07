import type { Page } from '@playwright/test'
import { administratorState, expect, test } from './fixtures.ts'
import { makeMatch, matchState, readMatch, uploadResult } from './matchApi.ts'
import { OpponentsPhone } from './pages/OpponentsPhone.ts'
import { ScoringPage } from './pages/ScoringPage.ts'
import { SignInPage } from './pages/SignInPage.ts'

const PHONE = { width: 390, height: 844 }

// The administrator's phone submits. It holds `matches.score`, so its
// results go to the API.
test.use({ storageState: administratorState, viewport: PHONE })

let opponent: OpponentsPhone
let players: [string, string]

test.beforeAll(async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, storageState: administratorState })
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player
  await page.close()
  opponent = await OpponentsPhone.open(browser, baseURL)
  players = [me.id, opponent.player.id]
})

test.afterAll(async () => {
  await opponent.close()
})

async function backToTheScores(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Back to the scores' }).click()
  await page.getByRole('textbox').nth(1).waitFor()
}

test('a corrected result can be approved, and the result it corrected can’t', async ({ page }) => {
  const match = await makeMatch(page.request, players, { rated: true })
  const phone = new ScoringPage(page)
  await phone.open(match)

  const first = await phone.submit([11, 5])
  await expect.poll(() => matchState(page.request, match.id), { timeout: 10_000 }).toBe('awaiting 11-5')
  await backToTheScores(page)
  const corrected = await phone.submit([11, 6])
  await expect.poll(() => matchState(page.request, match.id), { timeout: 10_000 }).toBe('awaiting 11-6')

  const approved = await uploadResult(page.request, match.id, await opponent.approve(corrected))
  expect(approved.status, `the API took the corrected result: ${JSON.stringify(approved.body)}`).toBe(201)
  expect(await matchState(page.request, match.id)).toBe('final 11-6')

  const stale = await uploadResult(page.request, match.id, await opponent.approve(first))
  expect(stale.status, 'the API refused the result the correction replaced').toBe(409)
  expect(stale.body.errors[0].title).toBe("Another result replaced this one, so it can't be approved")
  expect(await matchState(page.request, match.id)).toBe('final 11-6')
})

test('an unrated match is final once its result is submitted', async ({ page }) => {
  const match = await makeMatch(page.request, players, { rated: false })
  const phone = new ScoringPage(page)
  await phone.open(match)

  await phone.submit([11, 7])

  await expect.poll(() => matchState(page.request, match.id), { timeout: 10_000 }).toBe('final 11-7')
})

// The envelope a result link holds, in hex, as the API takes it.
const envelopeOf = (link: string) => Buffer.from(link.split('#')[1], 'base64url').toString('hex')

// Every envelope the API took from the page's results, in order.
function landedResults(page: Page): string[] {
  const landed: string[] = []
  page.on('response', (response) => {
    if (!new URL(response.url()).pathname.endsWith('/approvals') || response.status() !== 201) return
    landed.push((response.request().postDataJSON() as { envelope: string }).envelope)
  })
  return landed
}

// No signal: the device reaches no API, but still reaches the dev server,
// which a real phone doesn't need, as the service worker holds the app.
const API = '**/api/v1/matches/*/{boards,approvals}'
const noSignal = (page: Page) => page.route(API, (route) => route.abort('internetdisconnected'))

test('a result and its correction submitted offline both reach the API once online, first first', async ({
  page,
}) => {
  const match = await makeMatch(page.request, players, { rated: true })
  const phone = new ScoringPage(page)
  await phone.open(match)
  const landed = landedResults(page)

  await noSignal(page)
  const first = await phone.submit([11, 5])
  await backToTheScores(page)
  const corrected = await phone.submit([11, 6])
  await page.unroute(API)

  await expect.poll(() => matchState(page.request, match.id), { timeout: 20_000 }).toBe('awaiting 11-6')
  expect(landed).toEqual([envelopeOf(first), envelopeOf(corrected)])
  const signed = (await readMatch(page.request, match.id)).history.filter((event) => event.kind === 'signed')
  expect(signed.map((event) => event.games)).toEqual([[[11, 5]], [[11, 6]]])
})

test('a result that hasn’t reached the API still goes after a reload', async ({ page }) => {
  const match = await makeMatch(page.request, players, { rated: true })
  const phone = new ScoringPage(page)
  await phone.open(match)
  await noSignal(page)
  const link = await phone.submit([11, 5])

  await page.reload()
  await page.getByRole('link', { name: /\/scores\/approvals\/new#/ }).waitFor()
  const landed = landedResults(page)
  await page.unroute(API)

  await expect.poll(() => matchState(page.request, match.id), { timeout: 20_000 }).toBe('awaiting 11-5')
  expect(landed).toEqual([envelopeOf(link)])
})
