import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { administratorState, expect, test } from './fixtures.ts'
import { makeMatch, matchesOf, matchState, readMatch } from './matchApi.ts'
import { ApprovalPage, tamper } from './pages/ApprovalPage.ts'
import { HomePage } from './pages/HomePage.ts'
import { NewMatchPage } from './pages/NewMatchPage.ts'
import { OpponentsPhone } from './pages/OpponentsPhone.ts'
import { ScoringPage } from './pages/ScoringPage.ts'
import { SignInPage } from './pages/SignInPage.ts'

type SessionResponse = components['schemas']['SessionResponse']
type AdminPlayersResponse = components['schemas']['AdminPlayersResponse']

const PHONE = { width: 390, height: 844 }

// The administrator's phone submits. It holds `matches.score`, so its
// results go to the API.
test.use({ storageState: administratorState, viewport: PHONE })

let opponent: OpponentsPhone
let players: [string, string]
// A player who plays none of the other matches, for a match that the
// guest or the administrator doesn't play.
let otherPlayer: string
// "A vs B", as the Matches page names the matches.
let vs = ''

async function newGuest(request: APIRequestContext) {
  const session = await request.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
  return ((await session.json()) as SessionResponse).data.account.player
}

test.beforeAll(async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, storageState: administratorState })
  await page.goto('/design-system')
  const me = (await new SignInPage(page).account()).player
  opponent = await OpponentsPhone.open(browser, baseURL)
  players = [me.id, opponent.player.id]
  vs = `${me.display_name} vs ${opponent.player.display_name}`
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

async function backToTheScores(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Back to the scores' }).click()
  await page.getByRole('textbox').nth(1).waitFor()
}

// Opens the approved link on the submitter's phone, which sends it to
// FortyMM, as the guest's phone can't.
async function openApproved(page: Page, link: string): Promise<ApprovalPage> {
  const approval = new ApprovalPage(page)
  await approval.open(link)
  return approval
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

  const approved = await openApproved(page, await opponent.approve(corrected))
  await expect(approved.status('Approved. FortyMM has the result.')).toBeVisible()
  expect(await matchState(page.request, match.id)).toBe('final 11-6')

  const stale = await openApproved(page, await opponent.approve(first))
  await expect(stale.refusal).toContainText('Newer scores replaced these.')
  await expect(stale.main).not.toContainText('Approved')
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

// Opens the match from Matches, in the same session, and presses Keep score.
async function keepScoreFromMatches(page: Page, id: string): Promise<void> {
  await page.getByRole('link', { name: 'Home' }).click()
  await new HomePage(page).navLink('Matches').click()
  // Other matches in this file have the same players.
  await page.locator(`a[href="/matches/${id}"]`).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(vs)
  await expect(page.getByText('Game 1', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Keep score' }).click()
}

test('a match whose scoring tab was lost carries on from the match page to final', async ({ page }) => {
  const id = await startMatch(page)
  const phone = new ScoringPage(page)
  await phone.save(1, [11, 5])
  await expect.poll(() => matchState(page.request, id), { timeout: 10_000 }).toBe('live 11-5')

  await keepScoreFromMatches(page, id)
  await expect(phone.heading).toHaveText('Game 2')
  await expect(phone.points(1)).toHaveText('11–5')
  await phone.save(2, [7, 11])
  await expect.poll(() => matchState(page.request, id), { timeout: 10_000 }).toBe('live 11-5 7-11')

  // The match page has a read from before game 2 cached.
  await keepScoreFromMatches(page, id)
  await expect(phone.heading).toHaveText('Game 3')
  await expect(phone.points(2)).toHaveText('7–11')
  const link = await phone.submit([11, 7])
  const approved = await openApproved(page, await opponent.approve(link))
  await expect(approved.status('Approved. FortyMM has the result.')).toBeVisible()
  expect(await matchState(page.request, id)).toBe('final 11-5 7-11 11-7')
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

  const approved = await openApproved(page, await opponent.approve(corrected))
  await expect(approved.status('Approved. FortyMM has the result.')).toBeVisible()
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

// The administrator's phone submits a rated 11–5, and the link goes round.
async function submittedLink(
  page: Page,
  between: [string, string] = players,
): Promise<{ id: string; link: string }> {
  const match = await makeMatch(page.request, between, { rated: true })
  const phone = new ScoringPage(page)
  await phone.open(match)
  const link = await phone.submit([11, 5])
  await expect.poll(() => matchState(page.request, match.id), { timeout: 10_000 }).toBe('awaiting 11-5')
  return { id: match.id, link }
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

    await expect(approval.status(`Waiting for ${opponent.player.display_name} to approve`)).toBeVisible()
    await expect(approval.main).toContainText('You reported that you won 1–0.')
    await expect(approval.approveButton).toHaveCount(0)
  })

  test('asks a guest who doesn’t play the match to sign in, with no Approve', async ({ page }) => {
    const { link } = await submittedLink(page, [players[0], otherPlayer])

    const approval = await openOn(opponent.context, link)

    await expect(approval.signIn).toHaveAttribute('href', `/api/v1/auth/login?return_to=${encodeURIComponent(link)}`)
    await expect(approval.approveButton).toHaveCount(0)
    await expect(approval.editScores).toHaveCount(0)
    await approval.page.close()
  })

  test('tells a signed-in account that doesn’t play the match it isn’t theirs', async ({ page }) => {
    // The guests play, and the guest's phone submits, so the administrator
    // is the stranger.
    const match = await makeMatch(page.request, [opponent.player.id, otherPlayer], { rated: true })
    const guestsPhone = await opponent.context.newPage()
    const keyRegistered = new HomePage(guestsPhone).keyRegistered()
    const phone = new ScoringPage(guestsPhone)
    await phone.open(match)
    await keyRegistered
    const link = await phone.submit([11, 5])
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

      const approval = await openOn(opponent.context, tamper(link, change))

      await expect(approval.heading).toHaveText('This link has been changed and can’t be trusted')
      await expect(approval.approveButton).toHaveCount(0)
      await approval.page.close()
    })
  }

  test('lets the opponent approve with no signal, and the approval holds', async ({ page }) => {
    const { id, link } = await submittedLink(page)
    const approval = new ApprovalPage(await opponent.context.newPage())
    const keyRegistered = new HomePage(approval.page).keyRegistered()
    await approval.open(link)
    await keyRegistered

    await opponent.context.setOffline(true)
    await approval.approveButton.click()
    await expect(approval.status('Approved on this device')).toBeVisible()
    await expect(approval.main).toContainText('Send this link back to your opponent, so their phone sends it to FortyMM.')
    const approved = approval.link
    await opponent.context.setOffline(false)
    await approval.page.close()
    expect(await matchState(page.request, id)).toBe('awaiting 11-5')

    const landed = await openApproved(page, approved)
    await expect(landed.status('Approved. FortyMM has the result.')).toBeVisible()
    expect(await matchState(page.request, id)).toBe('final 11-5')
  })
})
