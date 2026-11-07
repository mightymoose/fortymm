import { randomUUID } from 'node:crypto'
import { request as newRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'
import { HomePage } from './pages/HomePage.ts'
import { ScoringPage } from './pages/ScoringPage.ts'
import { SignInPage } from './pages/SignInPage.ts'

type SessionResponse = components['schemas']['SessionResponse']
type MatchRequest = components['schemas']['MatchRequest']
type MatchDetailResponse = components['schemas']['MatchDetailResponse']
type ApprovalResponse = components['schemas']['ApprovalResponse']

const PHONE = { width: 390, height: 844 }
const BOARDS = '**/api/v1/matches/*/boards'

// The administrator holds `matches.score`, so an API match's board syncs.
test.use({ storageState: administratorState, viewport: PHONE })

// The administrator's player and a new guest's, who play every match here.
let players: MatchRequest['players'] = []

// One guest for the whole file, because the suite stays under the guest
// account limit.
test.beforeAll(async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, storageState: administratorState })
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player
  await page.close()
  // A context without the administrator's cookies, which the file's
  // storageState would otherwise give it.
  const guest = await newRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const opponent = ((await (
    await guest.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
  ).json()) as SessionResponse).data.account.player
  await guest.dispose()
  players = [me.id, opponent.id]
})

async function makeMatch(request: APIRequestContext): Promise<MatchRequest> {
  const match: MatchRequest = { id: randomUUID(), best_of: 5, rated: false, players }
  const made = await request.post('/api/v1/matches', { data: match })
  expect(made.status(), `the API made the match: ${await made.text()}`).toBe(201)
  return match
}

// The match's games as the API has them, from the newest board.
async function apiGames(request: APIRequestContext, match: MatchRequest): Promise<number[][]> {
  const response = await request.get(`/api/v1/matches/${match.id}`)
  return ((await response.json()) as MatchDetailResponse).data.games
}

// Every request the page sends under `/api/v1/matches/`, as `METHOD path`.
function matchRequests(page: Page): string[] {
  const sent: string[] = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.startsWith('/api/v1/matches/')) sent.push(`${request.method()} ${pathname}`)
  })
  return sent
}

test('saves move on before the API answers, and both games reach it', async ({ page }) => {
  const match = await makeMatch(page.request)
  const phone = new ScoringPage(page)
  await phone.open(match)
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let held = 0
  await page.route(BOARDS, async (route) => {
    held += 1
    await released
    await route.continue()
  })

  await phone.save(1, [11, 7])
  await expect(phone.heading).toHaveText('Game 2')
  await phone.save(2, [9, 11])
  await expect(phone.heading).toHaveText('Game 3')
  expect(held, 'a board was on its way, held').toBe(1)
  // `Synced` shows for a moment only, so the wait starts before it can.
  const synced = phone.slotSync(2).filter({ hasText: 'Synced' }).waitFor()
  release()

  await expect.poll(() => apiGames(page.request, match), { timeout: 5000 }).toEqual([[11, 7], [9, 11]])
  await synced
})

test('a game stuck offline is the grey offline slot, with no amber, and goes once online', async ({
  page,
  context,
}) => {
  const match = await makeMatch(page.request)
  const phone = new ScoringPage(page)
  await phone.open(match)
  const style = (locator: Locator, property: string) =>
    locator.evaluate(
      (element, property) => element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(property),
      property,
    )
  const sent = matchRequests(page)

  await context.setOffline(true)
  await phone.save(1, [11, 7])

  await expect(phone.stripNote).toHaveText('Offline. Saved on this device.')
  await expect(phone.slot(1)).toHaveCSS('border-top-style', 'dashed')
  // Game 1 was the current game, so its accent edge fades out first.
  const usualBorder = await style(phone.slot(3), 'border-top-color')
  await expect(phone.slot(1), 'the stuck edge keeps the usual border colour').toHaveCSS(
    'border-top-color',
    usualBorder,
  )
  const labelGrey = await style(phone.strip.getByText('Games', { exact: true }), 'color')
  await expect(phone.stripNote, 'the note is the Games label’s grey').toHaveCSS('color', labelGrey)
  await test.info().attach('offline strip', { body: await phone.strip.screenshot(), contentType: 'image/png' })
  expect(sent, 'no board went out offline').toEqual([])

  await context.setOffline(false)
  await expect.poll(() => apiGames(page.request, match), { timeout: 5000 }).toEqual([[11, 7]])
  await expect(phone.stripNote).toBeHidden()
  await expect(phone.slot(1)).toHaveCSS('border-top-style', 'solid')
})

test('a board with no route out says offline once its send times out', async ({ page }) => {
  const match = await makeMatch(page.request)
  const phone = new ScoringPage(page)
  await phone.open(match)
  // Online, but every board's request goes nowhere and never answers.
  await page.route(BOARDS, () => {})

  await phone.save(1, [11, 7])
  await expect(phone.heading).toHaveText('Game 2')
  // The send gives up after 10 seconds.
  await expect(phone.stripNote).toHaveText('Offline. Saved on this device.', { timeout: 15_000 })
})

test('two phones on one match never change each other’s pad', async ({ page, browser, baseURL }) => {
  const match = await makeMatch(page.request)
  const otherPhone = await browser.newContext({ baseURL, storageState: administratorState, viewport: PHONE })
  try {
    const a = new ScoringPage(page)
    const b = new ScoringPage(await otherPhone.newPage())
    // A pull on a timer would fire within the 12 seconds the clocks skip.
    await a.page.clock.install()
    await b.page.clock.install()
    const sentByA = matchRequests(a.page)
    const sentByB = matchRequests(b.page)
    await a.open(match)
    await b.open(match)

    await a.save(1, [11, 5])
    await expect.poll(() => apiGames(page.request, match), { timeout: 5000 }).toEqual([[11, 5]])
    const aPad = a.fragment
    await b.save(1, [5, 11])
    // The newest board wins on the API.
    await expect.poll(() => apiGames(page.request, match), { timeout: 5000 }).toEqual([[5, 11]])
    const bPad = b.fragment
    await a.page.clock.runFor(12_000)
    await b.page.clock.runFor(12_000)
    await expect(a.points(1)).toHaveText('11–5')
    expect(a.fragment, 'A’s pad is unchanged').toBe(aPad)

    const synced = a.slotSync(2).filter({ hasText: 'Synced' }).waitFor()
    await a.save(2, [11, 3])
    await expect.poll(() => apiGames(page.request, match), { timeout: 5000 }).toEqual([[11, 5], [11, 3]])
    await synced
    await b.page.clock.runFor(12_000)
    await expect(b.points(1)).toHaveText('5–11')
    await expect(b.points(2)).toHaveText('–')
    expect(b.fragment, 'B’s pad is unchanged').toBe(bPad)

    const boards = `POST /api/v1/matches/${match.id}/boards`
    expect(sentByA, 'A only sent its boards').toEqual([boards, boards])
    expect(sentByB, 'B only sent its board').toEqual([boards])
  } finally {
    await otherPhone.close()
  }
})

test('a final match refuses the board, and no game shows synced', async ({ page }) => {
  const match = await makeMatch(page.request)
  const phone = new ScoringPage(page)
  const keyRegistered = new HomePage(page).keyRegistered()
  await phone.open(match)
  await keyRegistered
  // The administrator's player approves a result with this browser's key.
  // The match is unrated, so one side's approval makes it final.
  const approval = await page.evaluate(
    async ({ match, modules }) => {
      const { signWithDeviceKey } = await import(modules.deviceKey)
      const { signResult } = await import(modules.envelope)
      const { hex } = await import(modules.bytes)
      const result = {
        match: match.id,
        bestOf: match.best_of,
        rated: match.rated,
        players: match.players,
        games: [[11, 0], [11, 0], [11, 0]],
        ending: 'completed',
        replaces: null,
      }
      const envelope = await signResult(await signWithDeviceKey(), Math.floor(Date.now() / 1000), result, 0)
      const response = await fetch(`/api/v1/matches/${match.id}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envelope: hex(envelope) }),
      })
      return { status: response.status, body: await response.text() }
    },
    {
      match,
      modules: {
        deviceKey: '/src/signing/deviceKey.ts',
        envelope: '/src/signing/envelope.ts',
        bytes: '/src/signing/bytes.ts',
      },
    },
  )
  expect(approval.status, `the API took the result: ${approval.body}`).toBe(201)
  expect((JSON.parse(approval.body) as ApprovalResponse).data.accepted_at, 'the match is final').not.toBeNull()

  await phone.watchSyncedMarks()
  await phone.save(1, [11, 7])

  await expect(phone.stripNote).toHaveText('Match final. A correction syncs once you submit it.')
  expect(await phone.everSynced(), 'no cell showed Synced').toBe(false)
})
