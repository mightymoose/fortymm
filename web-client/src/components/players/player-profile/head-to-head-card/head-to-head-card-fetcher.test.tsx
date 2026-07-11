import { HttpResponse, delay } from 'msw'

import {
  buildNeverMetHeadToHead,
  buildPlayerDetail,
  buildPlayerHeadToHead,
  buildSelfHeadToHead,
  buildViewerHeadToHead,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor, waitForElementToBeRemoved } from '@/test/utilities'

import { headToHeadCardFetcherPage } from './head-to-head-card-fetcher.page'

const PROFILE_ID = 'p-1'
const SOMEONE_ELSE = 'p-9'

describe('HeadToHeadCardFetcher', () => {
  it('suspends until the bundle resolves, then leads with YOUR record against them', async () => {
    // The record rides on the bundle — the card makes no request of its own, and
    // anything else would be unhandled and MSW would fail the test.
    headToHeadCardFetcherPage.signInAs(SOMEONE_ELSE)
    headToHeadCardFetcherPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          username: 'perky-ringtail',
          head_to_head: buildPlayerHeadToHead({
            versus_viewer: buildViewerHeadToHead({
              opponent: { id: PROFILE_ID, username: 'perky-ringtail' },
              wins: 1,
              losses: 4,
            }),
          }),
        }),
      )
    })

    headToHeadCardFetcherPage.render({ playerId: PROFILE_ID })

    await headToHeadCardFetcherPage.findLoading()
    await waitForElementToBeRemoved(headToHeadCardFetcherPage.queryLoading())

    expect(headToHeadCardFetcherPage.queryVersusLine()).toHaveTextContent(
      'You’re 1–4 against perky-ringtail',
    )
    // Read from the player's side it would be 4–1 — a fixture with a symmetric
    // record could not tell those two cards apart.
    expect(headToHeadCardFetcherPage.queryVersusLine()).not.toHaveTextContent(
      '4–1',
    )
  })

  it('renders the never-met invitation with a CTA that preseeds the match', async () => {
    // What a *guest* sees, which is anyone who lands on a shared profile link.
    headToHeadCardFetcherPage.signInAs(SOMEONE_ELSE)
    headToHeadCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          username: 'perky-ringtail',
          head_to_head: buildPlayerHeadToHead({
            versus_viewer: buildNeverMetHeadToHead({
              opponent: { id: PROFILE_ID, username: 'perky-ringtail' },
            }),
          }),
        }),
      ),
    )

    headToHeadCardFetcherPage.render({ playerId: PROFILE_ID })

    await headToHeadCardFetcherPage.findHeadToHeadCard()

    expect(headToHeadCardFetcherPage.queryInvite()).toHaveTextContent(
      'You haven’t played perky-ringtail yet.',
    )
    expect(headToHeadCardFetcherPage.getStartMatchHref()).toBe(
      `/matches/new?opponent=${PROFILE_ID}`,
    )
  })

  it('shows no self-record and no self-challenge on your own profile', async () => {
    // The API says so by *omitting* `versus_viewer` — that is the whole signal.
    headToHeadCardFetcherPage.signInAs(PROFILE_ID)
    headToHeadCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          username: 'rita.kovac',
          head_to_head: buildSelfHeadToHead(),
        }),
      ),
    )

    headToHeadCardFetcherPage.render({ playerId: PROFILE_ID })

    await headToHeadCardFetcherPage.findHeadToHeadCard()

    expect(headToHeadCardFetcherPage.getHeadToHeadTitle()).toBe(
      'Frequent opponents',
    )
    expect(headToHeadCardFetcherPage.queryVersusLine()).toBeNull()
    expect(headToHeadCardFetcherPage.queryStartMatchLink()).toBeNull()
    // …and it stays that way — a card that resolved "who am I?" off the session
    // would flip a beat later, once the session landed.
    await waitFor(() =>
      expect(headToHeadCardFetcherPage.queryStartMatchLink()).toBeNull(),
    )
  })

  it('picks its shape from the PAYLOAD, not the session — a dead session can’t break it', async () => {
    // A session-derived "is this me?" is false while the session is in flight (and
    // forever, if it fails). A card that branched its structure on it would, on
    // your own profile, try to render a "You're 1–4 against…" block off a record
    // the API deliberately did not send. The payload has no such gap: the server
    // decided, and it said "this is you".
    headToHeadCardFetcherPage.withFailingSession()
    headToHeadCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          username: 'rita.kovac',
          head_to_head: buildSelfHeadToHead(),
        }),
      ),
    )

    headToHeadCardFetcherPage.render({ playerId: PROFILE_ID })

    await headToHeadCardFetcherPage.findHeadToHeadCard()

    expect(headToHeadCardFetcherPage.getHeadToHeadTitle()).toBe(
      'Frequent opponents',
    )
    expect(headToHeadCardFetcherPage.queryStartMatchLink()).toBeNull()
    // The card painted, and the failed session did not take it (or the route's
    // error boundary) down with it.
    expect(headToHeadCardFetcherPage.queryError()).not.toBeInTheDocument()
  })

  it('propagates a failed bundle to the ancestor error boundary', async () => {
    // No per-card boundary by design: every card shares this one query.
    headToHeadCardFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    headToHeadCardFetcherPage.render({ playerId: PROFILE_ID })

    expect(await headToHeadCardFetcherPage.findError()).toBeInTheDocument()
    expect(headToHeadCardFetcherPage.queryLoading()).not.toBeInTheDocument()
  })
})
