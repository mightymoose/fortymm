import { HttpResponse } from 'msw'

import { playerByIdQueryOptions } from '@/api/players'
import {
  buildHeadToHeadOpponent,
  buildHeadToHeadRecord,
  buildNeverMetHeadToHead,
  buildPlayerDetail,
  buildPlayerHeadToHead,
  buildSelfHeadToHead,
  buildViewerHeadToHead,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor } from '@/test/utilities'

import { headToHeadCardQuery, type HeadToHeadView } from './head-to-head-card-query'
import { headToHeadCardQueryPage } from './head-to-head-card-query.page'

/** Resolve the query against one bundle and hand back the projected view. */
async function selectFrom(
  overrides: Parameters<typeof buildPlayerDetail>[0],
): Promise<HeadToHeadView> {
  headToHeadCardQueryPage.mockEndpoint(() =>
    HttpResponse.json(buildPlayerDetail(overrides)),
  )
  const { result } = headToHeadCardQueryPage.render()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  return result.current.data!
}

describe('headToHeadCardQuery', () => {
  it('reads the viewer’s record from the VIEWER’s side — 1–4, never 4–1', async () => {
    // The one thing this card has to get right. `A 4–1 B` and `B 1–4 A` are the
    // same head-to-head said two ways (CONTEXT.md), so the fixture is lopsided:
    // a projection that swapped the two would read "4–1" and this would catch it.
    const view = await selectFrom({
      head_to_head: buildPlayerHeadToHead({
        versus_viewer: buildViewerHeadToHead({ wins: 1, losses: 4 }),
      }),
    })

    expect(view.versusViewer?.record).toBe('1–4')
    expect(view.versusViewer?.meetings).toBe('5 meetings')
  })

  it('projects NULL for the viewer’s record on your OWN profile', async () => {
    // The API omits `versus_viewer` exactly when the caller is the player — you
    // have no record against yourself. That null is what the card branches its
    // whole structure on, so it must survive the projection intact.
    const view = await selectFrom({ head_to_head: buildSelfHeadToHead() })

    expect(view.versusViewer).toBeNull()
    // …and the rest of the card is still there: your frequent opponents.
    expect(view.frequentOpponents).toHaveLength(3)
  })

  it('marks a never-met pair as an invitation, not a 0–0 record', async () => {
    // Present with zero meetings — the *common* case (a guest has played nobody),
    // not an error. `neverMet` is what turns the card into the invitation, and
    // the meetings line and last-met date are dropped rather than shown as zeroes.
    const view = await selectFrom({
      head_to_head: buildPlayerHeadToHead({
        versus_viewer: buildNeverMetHeadToHead(),
      }),
    })

    expect(view.versusViewer?.neverMet).toBe(true)
    expect(view.versusViewer?.meetings).toBeNull()
    expect(view.versusViewer?.lastMeeting).toBeNull()
    // The opponent survives — the Start-a-match CTA prefills the match with them.
    expect(view.versusViewer?.opponent).toEqual({
      id: 'p-1',
      username: 'rita.kovac',
    })
  })

  it('formats when the pair last met, in UTC', async () => {
    // UTC so the day can't slip either way depending on where the reader sits —
    // the same choice the hero's "Member since" makes.
    const view = await selectFrom({
      head_to_head: buildPlayerHeadToHead({
        versus_viewer: buildViewerHeadToHead({
          last_meeting: '2025-03-14T23:30:00Z',
        }),
      }),
    })

    expect(view.versusViewer?.lastMeeting).toBe('Last met Mar 14, 2025')
  })

  it('omits an unreadable last-met date rather than printing "Invalid Date"', async () => {
    const view = await selectFrom({
      head_to_head: buildPlayerHeadToHead({
        versus_viewer: buildViewerHeadToHead({ last_meeting: 'not-a-date' }),
      }),
    })

    expect(view.versusViewer?.lastMeeting).toBeNull()
    // …and the record itself still reads, of course.
    expect(view.versusViewer?.record).toBe('1–4')
  })

  it('reads each frequent opponent from the PLAYER’s side, with a win share for the bar', async () => {
    // The list under your record is *theirs*, not yours — 6–2 is the player's
    // record against nia.brandt. The share is [0, 1] geometry for the bar, not copy.
    const view = await selectFrom({
      head_to_head: buildPlayerHeadToHead({
        frequent_opponents: [
          buildHeadToHeadRecord({
            opponent: buildHeadToHeadOpponent({
              id: 'p-21',
              username: 'nia.brandt',
            }),
            wins: 6,
            losses: 2,
          }),
        ],
      }),
    })

    expect(view.frequentOpponents).toEqual([
      {
        id: 'p-21',
        username: 'nia.brandt',
        record: '6–2',
        meetings: '8 meetings',
        winShare: 0.75,
      },
    ])
  })

  it('says "1 meeting", not "1 meetings"', async () => {
    const view = await selectFrom({
      head_to_head: buildPlayerHeadToHead({
        versus_viewer: buildViewerHeadToHead({ wins: 1, losses: 0 }),
        frequent_opponents: [buildHeadToHeadRecord({ wins: 0, losses: 1 })],
      }),
    })

    expect(view.versusViewer?.meetings).toBe('1 meeting')
    expect(view.frequentOpponents[0].meetings).toBe('1 meeting')
  })

  it('names the player, so the list can say whose rivalries it lists', async () => {
    const view = await selectFrom({ username: 'perky-ringtail' })

    expect(view.playerName).toBe('perky-ringtail')
  })

  it('reads the same cache entry as the profile bundle — no second request', () => {
    // The projection pattern's whole promise: same key, same fetch, a different
    // view. A key that forked here would silently double the page's network cost.
    expect(headToHeadCardQuery('p-1').queryKey).toEqual(
      playerByIdQueryOptions('p-1').queryKey,
    )
  })

  it('carries the LEAGUE in its key, like every other card on the page', () => {
    // Nothing in this view varies by league — a meeting is a decided match in any
    // league — but the key is the *bundle's*, not this card's. A card that dropped
    // the league would fetch the default ladder's bundle alongside everyone else's
    // `?league=` one, and the page would issue two requests instead of one
    // (ADR-0915).
    expect(headToHeadCardQuery('p-1', USATT_LEAGUE_ID).queryKey).toEqual(
      playerByIdQueryOptions('p-1', USATT_LEAGUE_ID).queryKey,
    )
    expect(headToHeadCardQuery('p-1', USATT_LEAGUE_ID).queryKey).not.toEqual(
      headToHeadCardQuery('p-1').queryKey,
    )
  })

  it('does not key the cache on WHO is looking — the server already did', () => {
    // The response varies by caller (ADR-0915), but the *key* must not: the viewer
    // is the session, one per browser, so keying on it would fork every player's
    // bundle into an identical second entry for no gain.
    expect(headToHeadCardQuery('p-1').queryKey).toEqual([
      'players',
      'detail',
      'p-1',
      null,
    ])
  })
})
