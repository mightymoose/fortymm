import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { resultsOf } from '../../scoring/results'
import { AcceptResultPage } from '../../test/pages/AcceptResultPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import { otherDevice } from '../../test/otherDevice'
import { API_BASE_URL, grantSession, mockApprovals, mockMatchReads, server, sessionResponse } from '../../test/server'
import { hex } from '../../signing/bytes'
import { signWithDeviceKey, takeKey } from '../../signing/deviceKey'
import { appendSignature, decodeEnvelope, signResult } from '../../signing/envelope'
import type { MatchResult, Side } from '../../signing/result'
import { base64url, fromBase64url } from '../../signing/text'
import { signInHref } from '../useSignInHref'

type MatchDetail = components['schemas']['MatchDetail']

const ME = sessionResponse.data.account.player
// The demo match's made-up opponent, whom the viewer stands in for.
const OPPONENT = '6f1d2c43-8b5e-4a0f-9c71-2e4b8d0a5f13'
// A demo match's made-up player, whose name this device knows.
const CRANE = '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40'
// The player of the phone that sent the link, whose name it doesn't.
const SENDER = '9d3f5a71-2c8e-4b06-a1d4-6e7f8a9b0c12'
const STRANGER = 'e2b4c6d8-1a3f-4e5b-9c7d-0f1e2d3c4b5a'
const ISSUED_AT = 1_793_700_000
const PREFIX = '/matches/demo/scores/approvals/new'
const API_MATCH = '01970000-0000-7000-8000-0000000000d1'

function result(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    match: '3b7e9f2a-6c41-4d8e-b5a0-1f9c2d7e4a63',
    bestOf: 5,
    rated: false,
    players: [SENDER, OPPONENT],
    games: [[11, 5], [7, 11], [11, 9], [11, 4]],
    ending: 'completed',
    replaces: null,
    ...overrides,
  } as MatchResult
}

// The link of `r` as the player on `reportedBy` sent it. By default the
// sender won 3–1, and the viewer stands in for the demo's opponent, so
// they review a loss.
async function link(r = result(), reportedBy: Side = 0): Promise<string> {
  const envelope = await signResult(await otherDevice(), ISSUED_AT, r, reportedBy)
  return `/matches/${r.match === result().match ? 'demo' : r.match}/scores/approvals/new#${base64url(envelope)}`
}

const apiResult = (players: [string, string]) => result({ match: API_MATCH, players, rated: true })

// FortyMM's read of the API match, with each side's name. The viewer plays
// side 1 unless `fields` says otherwise.
function apiMatch(names: [string, string], fields: Partial<MatchDetail> = {}): MatchDetail {
  return {
    id: API_MATCH,
    best_of: 5,
    rated: true,
    started_at: '2026-11-07T19:00:00Z',
    sides: names.map((name, side) => ({
      side: side as Side,
      players: [{ id: `${SENDER.slice(0, -1)}${side}`, display_name: name }],
    })),
    viewer_side: 1,
    games: [[11, 5], [7, 11], [11, 9], [11, 4]],
    retired_by: null,
    state: { kind: 'awaiting', signed_by: 0, signed_at: '2026-11-07T19:30:00Z' },
    history: [],
    ...fields,
  }
}

function signInAsVerified() {
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () =>
      HttpResponse.json<components['schemas']['SessionResponse']>({
        data: { account: { ...sessionResponse.data.account, kind: 'verified', email: 'egret@example.com' } },
      }),
    ),
  )
}

// Every API request the page makes after its session.
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

describe('AcceptResult, to the opponent', () => {
  it('asks them to review a loss, with their own name', async () => {
    const page = await AcceptResultPage.render(await link())

    expect(page.heading).toHaveTextContent('Review match score')
    expect(page.text).toContain('Your opponent reported that you lost 3–1. Do these scores look right?')
    expect(page.gameScores).toEqual([
      [`You · ${ME.display_name}`, '5', '11', '9', '4', '1'],
      ['Your opponent', '11', '7', '11', '11', '3'],
    ])
    expect(page.columns).toEqual(['Player', 'Game 1', 'Game 2', 'Game 3', 'Game 4', 'Won'])
    const reportedAt = new Date(ISSUED_AT * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    expect(page.result).toHaveTextContent(`Best of 5 · Unrated · Reported ${reportedAt}`)
    expect(page.text).not.toMatch(/sign/i)
    expect(page.status).toBeNull()
    expect(page.editScoresLink).toBeInTheDocument()
    expect(requests).toEqual([])
  })

  it('asks them to review a win, keeping each score on its player’s row', async () => {
    const page = await AcceptResultPage.render(await link(result({ players: [OPPONENT, SENDER] }), 1))

    expect(page.text).toContain('Your opponent reported that you won 3–1.')
    expect(page.gameScores).toEqual([
      [`You · ${ME.display_name}`, '11', '7', '11', '11', '3'],
      ['Your opponent', '5', '11', '9', '4', '1'],
    ])
  })

  it('names the opponent when the device knows them', async () => {
    const page = await AcceptResultPage.render(await link(result({ players: [CRANE, OPPONENT] })))

    expect(page.text).toContain('calm crane 552 reported that you lost 3–1.')
    expect(page.gameScores[1][0]).toBe('Your opponent · calm crane 552')
  })

  it('names the opponent from FortyMM’s read of the match', async () => {
    grantSession('matches.view')
    mockMatchReads([apiMatch(['epic elk 558', ME.display_name])])
    const page = await AcceptResultPage.render(await link(apiResult([SENDER, ME.id])))

    expect(await screen.findByText('epic elk 558 reported that you lost 3–1. Do these scores look right?')).toBeInTheDocument()
    expect(page.gameScores[1][0]).toBe('Your opponent · epic elk 558')
  })

  it('approves on this device, and keeps the approval in the URL', async () => {
    const page = await AcceptResultPage.render(await link())
    await page.waitForKey()
    await page.approve()

    expect(await page.findStatus()).toHaveTextContent('Approved on this device')
    expect(page.approveForm).toBeNull()
    expect(page.text).toContain('You lost 3–1.')
    expect(page.text).not.toContain('Send this link back')
    const { signatures } = decodeEnvelope(fromBase64url(page.hash))
    const signer = await signWithDeviceKey()
    expect(signatures.map(({ side }) => side)).toEqual([0, 1])
    expect(hex(signatures[1].kid)).toBe(hex(signer!.kid))
    // FortyMM has no demo match, so nothing goes to it.
    expect(requests).toEqual([])

    const href = page.router.state.location.href
    page.close()
    const reloaded = await AcceptResultPage.render(href)
    expect(await reloaded.findStatus()).toBeInTheDocument()
    expect(reloaded.gameScores[0][0]).toBe(`You · ${ME.display_name}`)
  })

  it('approves once when Approve is tapped twice at once', async () => {
    grantSession('matches.score')
    const approvals = mockApprovals()
    const page = await AcceptResultPage.render(await link(apiResult([SENDER, ME.id])))
    const sent = hex(fromBase64url(page.hash))
    await page.waitForKey()

    await page.approveTwiceAtOnce()
    await waitFor(() => expect(resultsOf(API_MATCH)).toEqual([]))
    await page.findChecked()

    const approved = hex(fromBase64url(page.hash))
    expect(decodeEnvelope(fromBase64url(page.hash)).signatures).toHaveLength(2)
    expect(approvals.checks.map(({ envelope }) => envelope)).toEqual([sent, approved, approved])
  })

  it('has a player who can’t send results ask the opponent’s phone to send it, and sends nothing', async () => {
    grantSession('matches.view')
    mockMatchReads([apiMatch(['epic elk 558', ME.display_name])])
    const page = await AcceptResultPage.render(await link(apiResult([SENDER, ME.id])))
    await screen.findByText(/^epic elk 558 reported/)
    await page.waitForKey()
    await page.approve()

    expect(await page.findStatus()).toHaveTextContent('Approved on this device')
    expect(page.text).toContain('Send this link back to epic elk 558, so their phone sends it to FortyMM.')
    expect(page.checking).toBe(false)
    expect(resultsOf(API_MATCH)).toEqual([])
    expect(requests.filter((path) => path.endsWith('/approvals'))).toEqual([])
  })

  it('shows a result the other player approved last as approved by both, and sends nothing', async () => {
    const mine = await signResult(await otherDevice(), ISSUED_AT, result(), 1)
    const both = await appendSignature(await otherDevice(), mine, 0)
    const page = await AcceptResultPage.render(`${PREFIX}#${base64url(both)}`)

    expect(page.notice('Approved by both players')).toBeInTheDocument()
    expect(page.approveForm).toBeNull()
    expect(requests).toEqual([])
  })

  it('goes back to edit the scores with the reviewed result, unchanged', async () => {
    const path = await link(result({ players: [OPPONENT, SENDER] }), 1)
    const page = await AcceptResultPage.render(path)
    const fragment = page.hash
    await page.editScores()

    await page.waitForScores('/matches/demo/scores/game/1/edit')
    const pad = new ScoreGamePage(page.router)
    expect(pad.hash).toBe(fragment)
    expect(pad.sides).toEqual(['You', 'Your opponent'])
    expect([1, 2, 3, 4].map((game) => pad.slotScore(game))).toEqual(['11–5', '7–11', '11–9', '11–4'])
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

  it.each([
    ['the opponent', [SENDER, ME.id] as [string, string], 1],
    ['the submitter', [ME.id, SENDER] as [string, string], 0],
  ] as const)('shows %s a link FortyMM has a final result for read only', async (_, sides, viewerSide) => {
    grantSession('matches.view')
    mockMatchReads([
      apiMatch(['epic elk 558', ME.display_name], {
        viewer_side: viewerSide,
        state: { kind: 'final', accepted_at: '2026-11-07T19:31:00Z', approved_by: [0], override_reason: null },
      }),
    ])
    const page = await AcceptResultPage.render(await link(apiResult(sides)))

    expect(await screen.findByText('This match is final, so there’s nothing left to approve.')).toBeInTheDocument()
    expect(page.approveButton).toBeNull()
    expect(page.editScoresLink).toBeNull()
    expect(page.text).not.toContain('Waiting for')
    expect(page.status).toBeNull()
  })

  it('says when the result corrects an earlier one', async () => {
    const page = await AcceptResultPage.render(await link(result({ replaces: new Uint8Array(32) })))

    expect(page.result).toHaveTextContent('Replaces the scores sent before')
  })

  it('says so when this browser has no signing key', async () => {
    const page = await AcceptResultPage.render(await link())
    await takeKey()
    await page.approve()

    expect(await page.findAlert()).toHaveTextContent('This browser can’t sign the result yet')
    expect(page.approveForm).toBeInTheDocument()
  })
})

describe('AcceptResult, to anyone else', () => {
  it('shows the submitter whom the result waits for, with no Approve', async () => {
    const page = await AcceptResultPage.render(await link(result({ players: [ME.id, OPPONENT] })))

    expect(page.text).toContain('You reported that you won 3–1.')
    expect(page.notice('Waiting for brave badger 214 to approve')).toBeInTheDocument()
    expect(page.approveButton).toBeNull()
    expect(page.editScoresLink).toBeInTheDocument()
    expect(page.status).toBeNull()
    expect(requests).toEqual([])
  })

  it('names whom an API match waits for once FortyMM answers, and says your opponent until then', async () => {
    grantSession('matches.view')
    const reads = mockMatchReads([apiMatch([ME.display_name, 'epic elk 558'], { viewer_side: 0 })])
    reads.hold = true
    const page = await AcceptResultPage.render(await link(apiResult([ME.id, SENDER])))

    expect(page.notice('Waiting for your opponent to approve')).toBeInTheDocument()
    await reads.release()
    await waitFor(() => expect(page.notice('Waiting for epic elk 558 to approve')).toBeInTheDocument())
    expect(page.approveButton).toBeNull()
  })

  it('tells a signed-in account that plays neither side that it isn’t their match', async () => {
    signInAsVerified()
    const page = await AcceptResultPage.render(await link(apiResult([SENDER, STRANGER])))

    expect(page.text).toContain('This isn’t your match, so you can’t approve it.')
    expect(page.gameScores.map((row) => row[0])).toEqual(['Player 1', 'Player 2'])
    expect(page.approveButton).toBeNull()
    expect(page.editScoresLink).toBeNull()
    expect(page.signInLink).toBeNull()
  })

  it('asks a guest who plays neither side to sign in, back to this link', async () => {
    const path = await link(apiResult([SENDER, STRANGER]))
    const page = await AcceptResultPage.render(path)

    expect(page.text).toContain('If it’s your match, sign in to approve it.')
    expect(page.signInLink).toHaveAttribute('href', signInHref(path))
    expect(page.approveButton).toBeNull()
    expect(page.editScoresLink).toBeNull()
  })

  it.each([
    ['a score', (bytes: Uint8Array) => (bytes[indexOf(bytes, [0x82, 0x0b, 0x09]) + 2] = 0x07)],
    ['a signature', (bytes: Uint8Array) => (bytes[bytes.length - 1] ^= 0x01)],
  ])('refuses a link with %s changed before offering Approve', async (_, change) => {
    const [path, hash] = (await link()).split('#')
    const bytes = fromBase64url(hash)
    change(bytes)
    const page = await AcceptResultPage.render(`${path}#${base64url(bytes)}`)

    expect(page.heading).toHaveTextContent('This link has been changed and can’t be trusted')
    expect(page.approveButton).toBeNull()
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
  // An API match's result that the viewer, who may send results, approved
  // last, as a reload after Approve shows it.
  async function approved(): Promise<AcceptResultPage> {
    grantSession('matches.score')
    const sent = await signResult(await otherDevice(), ISSUED_AT, apiResult([SENDER, ME.id]), 0)
    const both = await appendSignature(await otherDevice(), sent, 1)
    return AcceptResultPage.render(`/matches/${API_MATCH}/scores/approvals/new#${base64url(both)}`)
  }

  it('lands a result the opponent approved when the submitter reopens the link', async () => {
    grantSession('matches.score')
    const approvals = mockApprovals('accepted', { hold: true })
    const sent = await signResult(await otherDevice(), ISSUED_AT, apiResult([ME.id, SENDER]), 0)
    const both = await appendSignature(await otherDevice(), sent, 1)
    const page = await AcceptResultPage.render(`/matches/${API_MATCH}/scores/approvals/new#${base64url(both)}`)

    await waitFor(() => expect(page.checking).toBe(true))
    expect(page.status).toHaveTextContent('Approved by both players')
    await approvals.release()
    expect(await page.findChecked()).toBeInTheDocument()
    expect(approvals.checks.map(({ envelope }) => envelope)).toEqual([hex(both)])
    expect(resultsOf(API_MATCH)).toEqual([])
  })

  it('sends the result with both approvals to its match', async () => {
    const approvals = mockApprovals()
    const page = await approved()

    expect(await page.findChecked()).toBeInTheDocument()
    expect(page.text).not.toContain('Approved on this device')
    expect(approvals.checks).toHaveLength(1)
    const [check] = approvals.checks
    expect(check.matchId).toBe(API_MATCH)
    expect(check.envelope).toBe(hex(fromBase64url(page.hash)))
    const { signatures } = decodeEnvelope(fromBase64url(page.hash))
    expect(signatures.map(({ side }) => side)).toEqual([0, 1])
  })

  it('says it’s approved on this device while FortyMM checks it', async () => {
    const approvals = mockApprovals('accepted', { hold: true })
    const page = await approved()

    await waitFor(() => expect(page.checking).toBe(true))
    expect(page.status).toHaveTextContent('Approved on this device')
    await approvals.release()
    expect(await page.findChecked()).toBeInTheDocument()
    expect(page.checking).toBe(false)
  })

  it.each([
    [
      "A signature's account doesn't play as or manage the player it signs for",
      422,
      'The approval came from an account that doesn’t play this match.',
    ],
    ["A signature doesn't match the result", 422, 'The scores were changed after they were sent.'],
    ["A signature's key isn't registered, or was revoked", 422, 'FortyMM doesn’t know one of the phones this result came from.'],
    ["Another result replaced this one, so it can't be approved", 409, 'Newer scores replaced these.'],
    ["You don't have permission to do this", 403, 'This account can’t send results to FortyMM yet.'],
    ['No match has this id', 404, 'FortyMM has no record of this match.'],
    ['Something new', 422, 'Ask your opponent for the link again.'],
  ])('says in plain words why FortyMM refused it: %s', async (title, status, sentence) => {
    mockApprovals({ refused: title, status })
    const page = await approved()

    const refusal = await page.findRefusal()
    expect(refusal).toHaveTextContent(sentence)
    expect(refusal).not.toHaveTextContent(title)
    expect(page.text).not.toMatch(/approved/i)
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

function indexOf(bytes: Uint8Array, needle: number[]): number {
  return bytes.findIndex((_, at) => needle.every((byte, offset) => bytes[at + offset] === byte))
}
