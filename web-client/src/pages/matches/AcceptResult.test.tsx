import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcceptResultPage } from '../../test/pages/AcceptResultPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import { mockApprovals, server, sessionResponse } from '../../test/server'
import { hex } from '../../signing/bytes'
import { signWithDeviceKey, takeKey } from '../../signing/deviceKey'
import { appendSignature, decodeEnvelope, signResult, type Signer } from '../../signing/envelope'
import type { MatchResult, Side } from '../../signing/result'
import { base64url, fromBase64url } from '../../signing/text'

const ME = sessionResponse.data.account.player
const ALICE = '6f1d2c43-8b5e-4a0f-9c71-2e4b8d0a5f13'
const BOB = '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40'
const ISSUED_AT = 1_793_700_000
const PREFIX = '/matches/demo/scores/approvals/new'

function result(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    match: '3b7e9f2a-6c41-4d8e-b5a0-1f9c2d7e4a63',
    bestOf: 5,
    rated: false,
    players: [ALICE, BOB],
    games: [[11, 5], [7, 11], [11, 9], [11, 4]],
    ending: 'completed',
    replaces: null,
    ...overrides,
  } as MatchResult
}

async function otherDevice(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return {
    kid: crypto.getRandomValues(new Uint8Array(32)),
    sign: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)),
  }
}

// The link of `r` as the player on `reportedBy` sent it, so the viewer
// reviews it as the other player.
async function link(r = result(), reportedBy: Side = 0): Promise<string> {
  const envelope = await signResult(await otherDevice(), ISSUED_AT, r, reportedBy)
  return `/matches/demo/scores/approvals/new#${base64url(envelope)}`
}

// Every API request the page makes after its session, so a test can show
// that it looks up no username.
let requests: string[] = []
const record = ({ request }: { request: Request }) => {
  const { pathname } = new URL(request.url)
  if (pathname !== '/api/v1/session' && pathname !== '/api/v1/account/signing-keys') requests.push(pathname)
}
beforeEach(() => {
  requests = []
  server.events.on('request:start', record)
})
afterEach(() => {
  server.events.removeListener('request:start', record)
})

describe('AcceptResult', () => {
  it('asks the second player to review a loss, with no usernames', async () => {
    const page = await AcceptResultPage.render(await link())

    expect(page.heading).toHaveTextContent('Review match score')
    expect(page.text).toContain('Your opponent reported that you lost 3–1. Do these scores look right?')
    expect(page.gameScores).toEqual([
      ['You', '5', '11', '9', '4', '1'],
      ['Your opponent', '11', '7', '11', '11', '3'],
    ])
    expect(page.columns).toEqual(['Player', 'Game 1', 'Game 2', 'Game 3', 'Game 4', 'Won'])
    const reportedAt = new Date(ISSUED_AT * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    expect(page.result).toHaveTextContent(`Best of 5 · Unrated · Reported ${reportedAt}`)
    expect(page.text).not.toMatch(/sign/i)
    expect(page.status).toBeNull()
    expect(requests).toEqual([])
  })

  it('asks the first player to review a win, keeping each score on its player’s row', async () => {
    const page = await AcceptResultPage.render(await link(result(), 1))

    expect(page.text).toContain('Your opponent reported that you won 3–1.')
    expect(page.gameScores).toEqual([
      ['You', '11', '7', '11', '11', '3'],
      ['Your opponent', '5', '11', '9', '4', '1'],
    ])
  })

  it('shows the viewer’s username when they are the player under review', async () => {
    const page = await AcceptResultPage.render(await link(result({ players: [ALICE, ME.id] })))

    expect(page.gameScores.map((row) => row[0])).toEqual([`You · ${ME.display_name}`, 'Your opponent'])
  })

  it('approves on this device, and keeps the approval in the URL', async () => {
    const page = await AcceptResultPage.render(await link())
    await page.waitForKey()
    await page.approve()

    expect(await page.findStatus()).toHaveTextContent('Approved on this device')
    expect(page.approveForm).toBeNull()
    expect(page.text).toContain('You approved that you lost 3–1.')
    expect(page.gameScores.map((row) => row[0])).toEqual(['You', 'Your opponent'])
    const { signatures } = decodeEnvelope(fromBase64url(page.hash))
    const signer = await signWithDeviceKey()
    expect(signatures.map(({ side }) => side)).toEqual([0, 1])
    expect(hex(signatures[1].kid)).toBe(hex(signer!.kid))
    expect(requests).toEqual([`/api/v1/matches/${result().match}/approvals`])

    const href = page.router.state.location.href
    page.close()
    const reloaded = await AcceptResultPage.render(href)
    expect(reloaded.status).toHaveTextContent('Approved on this device')
    expect(reloaded.gameScores[0][0]).toBe('You')
  })

  it('shows a result with both approvals as approved', async () => {
    const envelope = await appendSignature(
      await otherDevice(),
      decodeLink(await link()),
      1,
    )
    const page = await AcceptResultPage.render(`/matches/demo/scores/approvals/new#${base64url(envelope)}`)

    expect(page.status).toHaveTextContent('Approved on this device')
    expect(page.approveForm).toBeNull()
  })

  it('goes back to edit the scores with the reviewed result, unchanged', async () => {
    const reported = result({ players: [BOB, ALICE] })
    const path = await link(reported)
    const page = await AcceptResultPage.render(path)
    const fragment = page.hash
    await page.editScores()

    await page.waitForScores('/matches/demo/scores/game/1/edit')
    const pad = new ScoreGamePage(page.router)
    expect(pad.hash).toBe(fragment)
    expect(pad.sides).toEqual(['You', 'Your opponent'])
    expect([1, 2, 3, 4].map((game) => pad.slotScore(game))).toEqual(['5–11', '11–7', '9–11', '4–11'])
    expect(requests).toEqual([])
  })

  it('carries both approvals to the scores after approving', async () => {
    const page = await AcceptResultPage.render(await link())
    await page.waitForKey()
    await page.approve()
    await page.findStatus()
    const approved = page.hash

    expect(screen.getByRole('link', { name: 'Edit scores' }).getAttribute('href')).toBe(
      `/matches/demo/scores/game/1/edit#${approved}`,
    )
  })

  it('says when the result corrects an earlier one', async () => {
    const page = await AcceptResultPage.render(await link(result({ replaces: new Uint8Array(32) })))

    expect(page.result).toHaveTextContent('Corrects an earlier result')
  })

  it('says so when this browser has no signing key', async () => {
    const page = await AcceptResultPage.render(await link())
    await takeKey()
    await page.approve()

    expect(await page.findAlert()).toHaveTextContent('This browser can’t sign the result yet')
    expect(page.approveForm).toBeInTheDocument()
  })

  it.each([
    ['no result', async () => ''],
    ['a damaged result', async () => '#not-a-result'],
    ['a retirement', async () => (await link(result({ games: [[11, 5], [7, 5]], ending: 'retired', retiredBy: 0 } as Partial<MatchResult>))).slice(PREFIX.length)],
    ['another best of', async () => (await link(result({ bestOf: 7 }))).slice(PREFIX.length)],
    ['an illegal game', async () => (await link(result({ games: [[11, 10]] }))).slice(PREFIX.length)],
  ])('says a link with %s isn’t a result', async (_, fragment) => {
    const page = await AcceptResultPage.render(`${PREFIX}${await fragment()}`)

    expect(page.heading).toHaveTextContent('This link isn’t a FortyMM result')
  })
})

describe('AcceptResult’s check with FortyMM', () => {
  async function approved(): Promise<AcceptResultPage> {
    const page = await AcceptResultPage.render(await link())
    await page.waitForKey()
    await page.approve()
    await page.findStatus()
    return page
  }

  it('sends the result with both approvals to its match', async () => {
    const approvals = mockApprovals()
    const page = await approved()

    expect(await page.findChecked()).toBeInTheDocument()
    expect(approvals.checks).toHaveLength(1)
    const [check] = approvals.checks
    expect(check.matchId).toBe(result().match)
    expect(check.envelope).toBe(hex(fromBase64url(page.hash)))
    const { signatures } = decodeEnvelope(fromBase64url(page.hash))
    expect(signatures.map(({ side }) => side)).toEqual([0, 1])
  })

  it('shows its skeleton until FortyMM answers', async () => {
    const approvals = mockApprovals('accepted', { hold: true })
    const page = await approved()

    await waitFor(() => expect(page.checking).toBe(true))
    await approvals.release()
    expect(await page.findChecked()).toBeInTheDocument()
    expect(page.checking).toBe(false)
  })

  it('shows FortyMM’s reason when it refuses the result', async () => {
    mockApprovals({ refused: 'A signature’s key isn’t registered, or was revoked' })
    const page = await approved()

    const refusal = await page.findRefusal()
    expect(refusal).toHaveTextContent('A signature’s key isn’t registered, or was revoked')
    expect(page.status).toHaveTextContent('Approved on this device')
  })

  it('keeps the approval with no network, and checks again on Try again', async () => {
    const approvals = mockApprovals('unreachable')
    const page = await approved()

    const alert = await page.findAlert()
    expect(alert).toHaveTextContent('Try again')
    expect(page.status).toHaveTextContent('Approved on this device')

    approvals.answer = 'accepted'
    await page.tryAgain(alert)
    expect(await page.findChecked()).toBeInTheDocument()
    expect(approvals.checks).toHaveLength(2)
  })
})

function decodeLink(path: string): Uint8Array<ArrayBuffer> {
  return fromBase64url(path.split('#')[1])
}
