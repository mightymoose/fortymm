import type { Page } from '@playwright/test'
import { administratorState, expect, test } from './fixtures.ts'
import { makeMatch, matchesOf, matchState, readMatch, uploadResult } from './matchApi.ts'
import { HomePage } from './pages/HomePage.ts'
import { NewMatchPage } from './pages/NewMatchPage.ts'
import { OpponentsPhone } from './pages/OpponentsPhone.ts'
import { ScoringPage } from './pages/ScoringPage.ts'
import { SignInPage } from './pages/SignInPage.ts'

const PHONE = { width: 390, height: 844 }

// The administrator's phone submits. It holds `matches.score`, so its
// results go to the API.
test.use({ storageState: administratorState, viewport: PHONE })

let opponent: OpponentsPhone
let players: [string, string]
// "A vs B", as the Matches page names the matches.
let vs = ''

test.beforeAll(async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, storageState: administratorState })
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player
  await page.close()
  opponent = await OpponentsPhone.open(browser, baseURL)
  players = [me.id, opponent.player.id]
  vs = `${me.display_name} vs ${opponent.player.display_name}`
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

// A lost scoring tab carries on from the match's page. These share the
// file's guest, as one more would pass the suite's guest account limit.

// Starts a best of 3 against the opponent through New match, and gives its
// id once game 1 opens.
async function startMatch(page: Page): Promise<string> {
  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await newMatch.pickBySearch(opponent.player.display_name)
  await page.getByRole('radio', { name: '3 Short' }).click()
  await newMatch.startButton.click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Game 1')
  return new URL(page.url()).pathname.split('/')[2]
}

test('a match whose scoring tab was lost carries on from the match page to final', async ({ page }) => {
  const id = await startMatch(page)
  const phone = new ScoringPage(page)
  await phone.save(1, [11, 5])
  await expect.poll(() => matchState(page.request, id), { timeout: 10_000 }).toBe('live 11-5')

  await page.getByRole('link', { name: 'Home' }).click()
  await new HomePage(page).navLink('Matches').click()
  // Other matches in this file have the same players.
  await page.locator(`a[href="/matches/${id}"]`).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(vs)
  // Start cached the match before its board. The dev server's StrictMode
  // mounts the page twice, which cancels its refetch on arrival, so the
  // page catches up on its 10-second refetch.
  await expect(page.getByText('Game 1', { exact: true })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Keep score' }).click()

  await expect(phone.heading).toHaveText('Game 2')
  await expect(phone.points(1)).toHaveText('11–5')
  const link = await phone.submit([11, 7])
  const approved = await uploadResult(page.request, id, await opponent.approve(link))
  expect(approved.status, `the API took the result: ${JSON.stringify(approved.body)}`).toBe(201)
  expect(await matchState(page.request, id)).toBe('final 11-5 11-7')
})

test('a correction made from the match page is approved, not refused as stale', async ({ page }) => {
  const match = await makeMatch(page.request, players, { rated: true })
  const phone = new ScoringPage(page)
  await phone.open(match)
  await phone.submit([11, 5])
  await expect.poll(() => matchState(page.request, match.id), { timeout: 10_000 }).toBe('awaiting 11-5')

  await page.goto(`/matches/${match.id}`)
  await page.getByRole('link', { name: 'Keep score' }).click()
  await expect(phone.points(1)).toHaveText('11–5')
  const corrected = await phone.submit([11, 6])
  await expect.poll(() => matchState(page.request, match.id), { timeout: 10_000 }).toBe('awaiting 11-6')

  const approved = await uploadResult(page.request, match.id, await opponent.approve(corrected))
  expect(approved.status, `the API took the correction: ${JSON.stringify(approved.body)}`).toBe(201)
  expect(await matchState(page.request, match.id)).toBe('final 11-6')
})

test('a scoring URL with no scores rebuilds the board from the server', async ({ page }) => {
  const match = await makeMatch(page.request, players, { rated: false, bestOf: 3 })
  const phone = new ScoringPage(page)
  await phone.open(match)
  await phone.save(1, [11, 5])
  await expect.poll(() => matchState(page.request, match.id), { timeout: 10_000 }).toBe('live 11-5')

  await page.goto(`/matches/${match.id}/scores/game/1/edit`)

  await expect(phone.heading).toHaveText('Game 2')
  await expect(phone.points(1)).toHaveText('11–5')
  expect(phone.fragment).not.toBe('')
})

test('Back right after Start opens the match, so a second Start can’t make another', async ({ page }) => {
  const before = await matchesOf(page.request, players)
  const id = await startMatch(page)

  await page.goBack()

  await expect(page).toHaveURL(new RegExp(`/matches/${id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(vs)
  await expect(page.getByRole('button', { name: 'Start match' })).toHaveCount(0)
  const made = (await matchesOf(page.request, players)).filter((other) => !before.includes(other))
  expect(made).toEqual([id])
})
