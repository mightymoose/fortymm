import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { queueResult, resultsOf } from '../../scoring/results'
import { hex } from '../../signing/bytes'
import { decodeEnvelope, signResult } from '../../signing/envelope'
import { resultHash, type MatchResult } from '../../signing/result'
import { base64url, fromBase64url } from '../../signing/text'
import { otherDevice as device } from '../../test/otherDevice'
import { AcceptResultPage } from '../../test/pages/AcceptResultPage'
import { API_BASE_URL, grantSession, mockApprovals, server, sessionResponse } from '../../test/server'

const player = sessionResponse.data.account.player
const GECKO = 'a4d8f0e6-1b2c-4e3d-8f5a-9c7b6e1d2f08'
const MATCH = '01970000-0000-7000-8000-0000000000c8'

describe('the approval page and the results outbox', () => {
  it('sends nothing for a link that’s only opened, as the viewer hasn’t approved it', async () => {
    grantSession('matches.score')
    const approvals = mockApprovals()
    const page = await renderCounter()
    await page.waitForKey()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(screen.getByRole('button', { name: 'Approve result' })).toBeInTheDocument()
    expect(resultsOf(MATCH)).toEqual([])
    expect(approvals.checks).toEqual([])
  })

  it('queues the link’s result, then the approved one, once the viewer approves', async () => {
    grantSession('matches.score')
    const approvals = mockApprovals()
    const page = await renderCounter()
    const link = page.hash
    await page.waitForKey()

    await page.approve()
    expect(await page.findStatus()).toHaveTextContent('Approved on this device')

    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]))
    const approved = hex(fromBase64url(page.hash))
    await waitFor(() =>
      expect(approvals.checks.map(({ envelope }) => envelope)).toEqual([hex(fromBase64url(link)), approved, approved]),
    )
  })

  it('checks an approved counter only after the queued result it replaces lands', async () => {
    grantSession('matches.score')
    const first: MatchResult = {
      match: MATCH,
      bestOf: 5,
      rated: false,
      players: [player.id, GECKO],
      games: [[11, 5], [11, 9], [11, 2]],
      ending: 'completed',
      replaces: null,
    } as MatchResult
    // This device submitted R1 for side 0, and it still waits to go.
    const r1 = base64url(await signResult(await device(), 1_793_700_000, first, 0))
    const r1Hash = resultHash(decodeEnvelope(fromBase64url(r1)).payload)
    // The opponent countered it on their phone, for side 1.
    const counter = { ...first, games: [[11, 5], [9, 11], [11, 2], [11, 4]], replaces: await r1Hash } as MatchResult
    const r2 = base64url(await signResult(await device(), 1_793_700_100, counter, 1))

    // A server with a chain: R1's first try gets a 503, as on a hall's weak
    // signal, and R2 before R1 is stale.
    const order: string[] = []
    let head: string | null = null
    let r1Tries = 0
    server.use(
      http.post<{ matchId: string }, { envelope: string }>(
        `${API_BASE_URL}/v1/matches/:matchId/approvals`,
        async ({ request }) => {
          const { envelope } = await request.json()
          const isR1 = envelope === hex(fromBase64url(r1))
          order.push(isR1 ? 'R1' : 'R2')
          if (isR1 && r1Tries++ === 0) return HttpResponse.json({ errors: [{ status: '503', title: 'busy' }] }, { status: 503 })
          if (!isR1 && head === null) {
            return HttpResponse.json(
              { errors: [{ status: '409', title: "The result doesn't replace the match's newest result" }] },
              { status: 409 },
            )
          }
          head = isR1 ? 'R1' : 'R2'
          return HttpResponse.json(
            { data: { hash: '00', match_id: MATCH, approvals: [], accepted_at: null } },
            { status: 201 },
          )
        },
      ),
    )
    queueResult(MATCH, r1)

    const page = await AcceptResultPage.render(`/matches/${MATCH}/scores/approvals/new#${r2}`)
    await page.waitForKey()
    await page.approve()
    expect(await page.findStatus()).toHaveTextContent('Approved on this device')
    await waitFor(() => expect(screen.getByText(/FortyMM has the result/)).toBeInTheDocument(), {
      timeout: 6000,
    })
    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]), { timeout: 6000 })

    expect(order.slice(0, 3)).toEqual(['R1', 'R1', 'R2'])
    expect(head).toBe('R2')
  }, 15000)

  it('sends an approval again once the result it corrects reaches the API from the other phone', async () => {
    grantSession('matches.score')
    const approvals = mockApprovals({ refused: "The result doesn't replace the match's newest result", status: 409 })
    const page = await renderCounter()
    await page.waitForKey()
    await page.approve()
    expect(await page.findStatus()).toHaveTextContent('Approved on this device')
    const approved = hex(fromBase64url(page.hash))
    expect(
      await screen.findByText('FortyMM can’t take it yet, so this device keeps sending it', {}, { timeout: 16_000 }),
    ).toBeInTheDocument()
    expect(approvals.checks.some(({ envelope }) => envelope === approved)).toBe(true)

    approvals.answer = 'accepted'

    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]), { timeout: 8000 })
    expect(await screen.findByText('Approved. FortyMM has the result.')).toBeInTheDocument()
  }, 30_000)

  it('says an approval waits while this device’s key registers, and checked once it lands', async () => {
    grantSession('matches.score')
    const approvals = mockApprovals({ refused: "A signature's key isn't registered, or was revoked", status: 422 })
    const page = await renderCounter()
    await page.waitForKey()
    await page.approve()
    expect(await page.findStatus()).toHaveTextContent('Approved on this device')
    expect(
      await screen.findByText('FortyMM can’t take it yet, so this device keeps sending it', {}, { timeout: 16_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('FortyMM didn’t accept this result')).not.toBeInTheDocument()

    approvals.answer = 'accepted'

    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]), { timeout: 8000 })
    expect(await screen.findByText('Approved. FortyMM has the result.')).toBeInTheDocument()
  }, 30_000)

  it('tries every queued result again on the next pass, once the result they replace lands from another phone', async () => {
    grantSession('matches.score')
    const r1 = await signedResult(null, 0)
    const r2 = await signedResult(await hashOf(r1), 1)
    const r3 = await signedResult(await hashOf(r2), 0)
    const chain = mockLongChain([r1, r2, r3])
    queueResult(MATCH, r2)
    queueResult(MATCH, r3)
    await AcceptResultPage.render(`/matches/${MATCH}/scores/approvals/new#${r3}`)
    await waitFor(() => expect(chain.order).toEqual(['r2', 'r3']))

    chain.current = 'r1'
    window.dispatchEvent(new Event('online'))

    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]), { timeout: 5000 })
    expect(chain.order).toEqual(['r2', 'r3', 'r2', 'r3'])
    expect(chain.current).toBe('r3')
  })

  it('gives a predecessor queued after its corrections were put back a turn', async () => {
    grantSession('matches.score')
    const r1 = await signedResult(null, 0)
    const r2 = await signedResult(await hashOf(r1), 1)
    const r3 = await signedResult(await hashOf(r2), 0)
    const chain = mockLongChain([r1, r2, r3])
    queueResult(MATCH, r3)
    queueResult(MATCH, r2)
    await AcceptResultPage.render(`/matches/${MATCH}/scores/approvals/new#${r2}`)
    await waitFor(() => expect(chain.order.slice(0, 2)).toEqual(['r3', 'r2']))

    queueResult(MATCH, r1)

    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]), { timeout: 8000 })
    expect(chain.current).toBe('r3')
  }, 15_000)

  it('sends a result queued behind the correction of it first', async () => {
    grantSession('matches.score')
    const first = await signedResult(null, 0)
    const correction = await signedResult(await resultHash(decodeEnvelope(fromBase64url(first)).payload), 1)
    const head = mockChain(first)
    queueResult(MATCH, correction)
    await AcceptResultPage.render(`/matches/${MATCH}/scores/approvals/new#${first}`)

    queueResult(MATCH, first)

    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]), { timeout: 5000 })
    expect(head.order).toEqual(['correction', 'first', 'correction'])
    expect(head.current).toBe('correction')
  })

  it('drops a stale result signed more than a day ago', async () => {
    grantSession('matches.score')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApprovals({ refused: "The result doesn't replace the match's newest result", status: 409 })
    const page = await renderCounter(Math.floor(Date.now() / 1000) - 25 * 60 * 60)
    await page.waitForKey()
    await page.approve()

    expect(await screen.findByText('FortyMM didn’t accept this result', {}, { timeout: 16_000 })).toBeInTheDocument()
    await waitFor(() => expect(resultsOf(MATCH)).toEqual([]))
  })

})

// A counter from the opponent's phone, which corrects nothing this device
// knows.
async function renderCounter(issuedAt = Math.floor(Date.now() / 1000)): Promise<AcceptResultPage> {
  const counter = {
    match: MATCH,
    bestOf: 5,
    rated: false,
    players: [player.id, GECKO],
    games: [[9, 11], [11, 9], [11, 2], [11, 4]],
    ending: 'completed',
    replaces: null,
  } as MatchResult
  const envelope = base64url(await signResult(await device(), issuedAt, counter, 1))
  return AcceptResultPage.render(`/matches/${MATCH}/scores/approvals/new#${envelope}`)
}

// A result of the match, signed now for `side`, that replaces `replaces`.
async function signedResult(replaces: Uint8Array<ArrayBuffer> | null, side: 0 | 1): Promise<string> {
  const result = {
    match: MATCH,
    bestOf: 5,
    rated: false,
    players: [player.id, GECKO],
    games: side === 0 ? [[11, 5], [11, 9], [11, 2]] : [[11, 5], [9, 11], [11, 2], [11, 4]],
    ending: 'completed',
    replaces,
  } as MatchResult
  return base64url(await signResult(await device(), Math.floor(Date.now() / 1000), result, side))
}

// A chain of two results on the mock API: the correction is stale until
// `first` landed. Records each upload, by name, in `order`.
function mockChain(first: string) {
  const chain = { order: [] as string[], current: null as string | null }
  server.use(
    http.post<{ matchId: string }, { envelope: string }>(
      `${API_BASE_URL}/v1/matches/:matchId/approvals`,
      async ({ request }) => {
        const { envelope } = await request.json()
        const name = envelope === hex(fromBase64url(first)) ? 'first' : 'correction'
        chain.order.push(name)
        if (name === 'correction' && chain.current === null) {
          return HttpResponse.json(
            { errors: [{ status: '409', title: "The result doesn't replace the match's newest result" }] },
            { status: 409 },
          )
        }
        chain.current = name
        return HttpResponse.json(
          { data: { hash: '00', match_id: MATCH, approvals: [], accepted_at: null } },
          { status: 201 },
        )
      },
    ),
  )
  return chain
}

const hashOf = async (envelope: string) => resultHash(decodeEnvelope(fromBase64url(envelope)).payload)

// A chain on the mock API, where each of `results` is stale until the one
// before it landed. Records each upload, as r1, r2 and so on, in `order`.
function mockLongChain(results: string[]) {
  const chain = { order: [] as string[], current: null as string | null }
  server.use(
    http.post<{ matchId: string }, { envelope: string }>(
      `${API_BASE_URL}/v1/matches/:matchId/approvals`,
      async ({ request }) => {
        const { envelope } = await request.json()
        const index = results.findIndex((result) => hex(fromBase64url(result)) === envelope)
        const name = `r${index + 1}`
        chain.order.push(name)
        const before = index === 0 ? null : `r${index}`
        if (chain.current !== before && chain.current !== name) {
          return HttpResponse.json(
            { errors: [{ status: '409', title: "The result doesn't replace the match's newest result" }] },
            { status: 409 },
          )
        }
        chain.current = name
        return HttpResponse.json(
          { data: { hash: '00', match_id: MATCH, approvals: [], accepted_at: null } },
          { status: 201 },
        )
      },
    ),
  )
  return chain
}

