import { randomUUID } from 'node:crypto'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'
import { HomePage } from './pages/HomePage.ts'
import { ScoringPage } from './pages/ScoringPage.ts'
import { SignInPage } from './pages/SignInPage.ts'

type SessionResponse = components['schemas']['SessionResponse']
type MatchRequest = components['schemas']['MatchRequest']
type MatchDetailResponse = components['schemas']['MatchDetailResponse']
type ErrorResponse = components['schemas']['ErrorsResponse']

const PHONE = { width: 390, height: 844 }

// The administrator's phone submits. It holds `matches.score`, so its
// results go to the API.
test.use({ storageState: administratorState, viewport: PHONE })

// The opponent's phone, a guest's, kept for the whole file, because the
// suite stays under the guest account limit. A guest holds no
// `matches.score`, so the administrator's session uploads what the guest's
// phone approved: the signatures, not the session, are the authority.
let opponent: BrowserContext
let players: MatchRequest['players'] = []

test.beforeAll(async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, storageState: administratorState })
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player
  await page.close()
  opponent = await browser.newContext({ baseURL, viewport: PHONE, storageState: { cookies: [], origins: [] } })
  const session = await opponent.request.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
  const guest = ((await session.json()) as SessionResponse).data.account.player
  players = [me.id, guest.id]
})

test.afterAll(async () => {
  await opponent.close()
})

async function makeMatch(request: APIRequestContext, rated: boolean): Promise<MatchRequest> {
  const match: MatchRequest = { id: randomUUID(), best_of: 1, rated, players }
  const made = await request.post('/api/v1/matches', { data: match })
  expect(made.status(), `the API made the match: ${await made.text()}`).toBe(201)
  return match
}

async function apiMatch(request: APIRequestContext, match: MatchRequest): Promise<MatchDetailResponse['data']> {
  return ((await (await request.get(`/api/v1/matches/${match.id}`)).json()) as MatchDetailResponse).data
}

async function state(request: APIRequestContext, match: MatchRequest): Promise<string> {
  const { state, games } = await apiMatch(request, match)
  return `${state.kind} ${games.map(([a, b]) => `${a}-${b}`).join(' ')}`
}

// Submits game 1, left side first, and gives the approval link.
async function submit(phone: ScoringPage, [left, right]: [number, number]): Promise<string> {
  await phone.inputs.nth(0).fill(String(left))
  await phone.inputs.nth(1).fill(String(right))
  await phone.page.getByRole('button', { name: 'Submit result' }).click()
  const link = phone.page.getByRole('link', { name: /\/scores\/approvals\/new#/ })
  return (await link.getAttribute('href'))!
}

async function backToTheScores(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Back to the scores' }).click()
  await page.getByRole('textbox').nth(1).waitFor()
}

// Approves the result `link` holds on the opponent's phone, which works
// with no request of its own, and gives the envelope with both signatures.
async function approveOnOpponentsPhone(link: string): Promise<string> {
  const page = await opponent.newPage()
  try {
    const keyRegistered = new HomePage(page).keyRegistered()
    await page.goto(link)
    await keyRegistered
    const before = new URL(page.url()).hash
    await page.getByRole('button', { name: 'Approve result' }).click()
    await expect.poll(() => new URL(page.url()).hash).not.toBe(before)
    return new URL(page.url()).hash.slice(1)
  } finally {
    await page.close()
  }
}

async function upload(request: APIRequestContext, match: MatchRequest, envelope: string) {
  const response = await request.post(`/api/v1/matches/${match.id}/approvals`, {
    data: { envelope: Buffer.from(envelope, 'base64url').toString('hex') },
  })
  return { status: response.status(), body: (await response.json()) as ErrorResponse }
}

test('a corrected result can be approved, and the result it corrected can’t', async ({ page }) => {
  const match = await makeMatch(page.request, true)
  const phone = new ScoringPage(page)
  await phone.open(match)

  const first = await submit(phone, [11, 5])
  await expect.poll(() => state(page.request, match), { timeout: 10_000 }).toBe('awaiting 11-5')
  await backToTheScores(page)
  const corrected = await submit(phone, [11, 6])
  await expect.poll(() => state(page.request, match), { timeout: 10_000 }).toBe('awaiting 11-6')

  const approved = await upload(page.request, match, await approveOnOpponentsPhone(corrected))
  expect(approved.status, `the API took the corrected result: ${JSON.stringify(approved.body)}`).toBe(201)
  expect(await state(page.request, match)).toBe('final 11-6')

  const stale = await upload(page.request, match, await approveOnOpponentsPhone(first))
  expect(stale.status, 'the API refused the result the correction replaced').toBe(409)
  expect(stale.body.errors[0].title).toBe("Another result replaced this one, so it can't be approved")
  expect(await state(page.request, match)).toBe('final 11-6')
})

test('an unrated match is final once its result is submitted', async ({ page }) => {
  const match = await makeMatch(page.request, false)
  const phone = new ScoringPage(page)
  await phone.open(match)

  await submit(phone, [11, 7])

  await expect.poll(() => state(page.request, match), { timeout: 10_000 }).toBe('final 11-7')
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
  const match = await makeMatch(page.request, true)
  const phone = new ScoringPage(page)
  await phone.open(match)
  const landed = landedResults(page)

  await noSignal(page)
  const first = await submit(phone, [11, 5])
  await backToTheScores(page)
  const corrected = await submit(phone, [11, 6])
  await page.unroute(API)

  await expect.poll(() => state(page.request, match), { timeout: 20_000 }).toBe('awaiting 11-6')
  expect(landed).toEqual([envelopeOf(first), envelopeOf(corrected)])
  const signed = (await apiMatch(page.request, match)).history.filter((event) => event.kind === 'signed')
  expect(signed.map((event) => event.games)).toEqual([[[11, 5]], [[11, 6]]])
})

test('a result that hasn’t reached the API still goes after a reload', async ({ page }) => {
  const match = await makeMatch(page.request, true)
  const phone = new ScoringPage(page)
  await phone.open(match)
  await noSignal(page)
  const link = await submit(phone, [11, 5])

  await page.reload()
  await page.getByRole('link', { name: /\/scores\/approvals\/new#/ }).waitFor()
  const landed = landedResults(page)
  await page.unroute(API)

  await expect.poll(() => state(page.request, match), { timeout: 20_000 }).toBe('awaiting 11-5')
  expect(landed).toEqual([envelopeOf(link)])
})
