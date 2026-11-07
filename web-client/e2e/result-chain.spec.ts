import { randomUUID } from 'node:crypto'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'
import { ApprovalPage, tamper } from './pages/ApprovalPage.ts'
import { HomePage } from './pages/HomePage.ts'
import { ScoringPage } from './pages/ScoringPage.ts'
import { SignInPage } from './pages/SignInPage.ts'

type SessionResponse = components['schemas']['SessionResponse']
type SessionPlayer = components['schemas']['SessionPlayer']
type AdminPlayersResponse = components['schemas']['AdminPlayersResponse']
type MatchRequest = components['schemas']['MatchRequest']
type MatchDetailResponse = components['schemas']['MatchDetailResponse']

const PHONE = { width: 390, height: 844 }

// The administrator's phone submits. It holds `matches.score`, so its
// results go to the API.
test.use({ storageState: administratorState, viewport: PHONE })

// The opponent's phone, a guest's, kept for the whole file, because the
// suite stays under the guest account limit. A guest holds no
// `matches.score`, so its phone sends nothing. The administrator's phone
// lands what the guest approved when it opens the approved link: the
// signatures, not the session, are the authority.
let opponent: BrowserContext
let opponentPlayer: SessionPlayer
// A player who plays none of the other matches, for a match that the
// guest or the administrator doesn't play.
let otherPlayer: string
let players: MatchRequest['players'] = []

async function newGuest(request: APIRequestContext): Promise<SessionPlayer> {
  const session = await request.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
  return ((await session.json()) as SessionResponse).data.account.player
}

test.beforeAll(async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, storageState: administratorState })
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player
  opponent = await browser.newContext({ baseURL, viewport: PHONE, storageState: { cookies: [], origins: [] } })
  opponentPlayer = await newGuest(opponent.request)
  players = [me.id, opponentPlayer.id]
  // The suite's guest accounts are at the limit's edge, so this takes a
  // player another spec made, and makes one only when there is none.
  const listed = (await (await page.request.get('/api/v1/admin/players')).json()) as AdminPlayersResponse
  otherPlayer = listed.data.find((player) => !players.includes(player.id))?.id ?? ''
  if (!otherPlayer) {
    const context = await browser.newContext({ baseURL })
    otherPlayer = (await newGuest(context.request)).id
    await context.close()
  }
  await page.close()
})

test.afterAll(async () => {
  await opponent.close()
})

async function makeMatch(
  request: APIRequestContext,
  rated: boolean,
  between: MatchRequest['players'] = players,
): Promise<MatchRequest> {
  const match: MatchRequest = { id: randomUUID(), best_of: 1, rated, players: between }
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

// Approves the result `link` holds on the opponent's phone, which sends no
// request of its own, and gives the link with both signatures.
async function approveOnOpponentsPhone(link: string): Promise<string> {
  const page = await opponent.newPage()
  try {
    const keyRegistered = new HomePage(page).keyRegistered()
    await page.goto(link)
    await keyRegistered
    const before = new URL(page.url()).hash
    await page.getByRole('button', { name: 'Approve result' }).click()
    await expect.poll(() => new URL(page.url()).hash).not.toBe(before)
    const { pathname, hash } = new URL(page.url())
    return `${pathname}${hash}`
  } finally {
    await page.close()
  }
}

// Opens the approved link on the submitter's phone, which sends it to
// FortyMM, as the guest's phone can't.
async function openApproved(page: Page, link: string): Promise<ApprovalPage> {
  const approval = new ApprovalPage(page)
  await approval.open(link)
  return approval
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

  const approved = await openApproved(page, await approveOnOpponentsPhone(corrected))
  await expect(approved.status('Approved. FortyMM has the result.')).toBeVisible()
  expect(await state(page.request, match)).toBe('final 11-6')

  const stale = await openApproved(page, await approveOnOpponentsPhone(first))
  await expect(stale.refusal).toContainText('Newer scores replaced these.')
  await expect(stale.main).not.toContainText('Approved')
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

// The administrator's phone submits a rated 11–5, and the link goes round.
async function submittedLink(
  page: Page,
  between: MatchRequest['players'] = players,
): Promise<{ match: MatchRequest; link: string }> {
  const match = await makeMatch(page.request, true, between)
  const phone = new ScoringPage(page)
  await phone.open(match)
  const link = await submit(phone, [11, 5])
  await expect.poll(() => state(page.request, match), { timeout: 10_000 }).toBe('awaiting 11-5')
  return { match, link }
}

async function openOn(context: BrowserContext, link: string): Promise<ApprovalPage> {
  const approval = new ApprovalPage(await context.newPage())
  await approval.open(link)
  return approval
}

test.describe('the approval page', () => {
  test('shows the submitter whom the result waits for, with no Approve', async ({ page }) => {
    const { link } = await submittedLink(page)

    const approval = new ApprovalPage(page)
    await approval.open(link)

    await expect(approval.status(`Waiting for ${opponentPlayer.display_name} to approve`)).toBeVisible()
    await expect(approval.main).toContainText('You reported that you won 1–0.')
    await expect(approval.approveButton).toHaveCount(0)
  })

  test('asks a guest who doesn’t play the match to sign in, with no Approve', async ({ page }) => {
    const { link } = await submittedLink(page, [players[0], otherPlayer])

    const approval = await openOn(opponent, link)

    await expect(approval.signIn).toHaveAttribute('href', `/api/v1/auth/login?return_to=${encodeURIComponent(link)}`)
    await expect(approval.approveButton).toHaveCount(0)
    await expect(approval.editScores).toHaveCount(0)
    await approval.page.close()
  })

  test('tells a signed-in account that doesn’t play the match it isn’t theirs', async ({ page }) => {
    // The guests play, and the guest's phone submits, so the administrator
    // is the stranger.
    const match = await makeMatch(page.request, true, [opponentPlayer.id, otherPlayer])
    const guestsPhone = await opponent.newPage()
    const keyRegistered = new HomePage(guestsPhone).keyRegistered()
    const phone = new ScoringPage(guestsPhone)
    await phone.open(match)
    await keyRegistered
    const link = await submit(phone, [11, 5])
    await guestsPhone.close()

    const approval = new ApprovalPage(page)
    await approval.open(link)

    await expect(approval.main).toContainText('This isn’t your match, so you can’t approve it.')
    await expect(approval.approveButton).toHaveCount(0)
    await expect(approval.editScores).toHaveCount(0)
  })

  // Game 1's 11–5 is the CBOR array 0x82 0x0b 0x05. 11–6 is a legal score
  // too, so only the signature can tell.
  const changedScore = (bytes: Buffer): [number, number] => [bytes.indexOf(Buffer.from([0x82, 0x0b, 0x05])) + 2, 0x06]
  const changedSignature = (bytes: Buffer): [number, number] => [bytes.length - 1, bytes[bytes.length - 1] ^ 0x01]

  for (const [what, change] of [
    ['a score', changedScore],
    ['a signature', changedSignature],
  ] as const) {
    test(`refuses a link with ${what} changed before any Approve`, async ({ page }) => {
      const { link } = await submittedLink(page)

      const approval = await openOn(opponent, tamper(link, change))

      await expect(approval.heading).toHaveText('This link has been changed and can’t be trusted')
      await expect(approval.approveButton).toHaveCount(0)
      await approval.page.close()
    })
  }

  test('lets the opponent approve with no signal, and the approval holds', async ({ page }) => {
    const { match, link } = await submittedLink(page)
    const approval = new ApprovalPage(await opponent.newPage())
    const keyRegistered = new HomePage(approval.page).keyRegistered()
    await approval.open(link)
    await keyRegistered

    await opponent.setOffline(true)
    await approval.approveButton.click()
    await expect(approval.status('Approved on this device')).toBeVisible()
    await expect(approval.main).toContainText('Send this link back to your opponent, so their phone sends it to FortyMM.')
    const approved = approval.link
    await opponent.setOffline(false)
    await approval.page.close()
    expect(await state(page.request, match)).toBe('awaiting 11-5')

    const landed = await openApproved(page, approved)
    await expect(landed.status('Approved. FortyMM has the result.')).toBeVisible()
    expect(await state(page.request, match)).toBe('final 11-5')
  })
})
