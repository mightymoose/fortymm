import { HttpResponse } from 'msw'

import { playerByIdQueryOptions } from '@/api/players'
import {
  buildDefaultLeague,
  buildPlayerDetail,
  buildSecondLeague,
  buildUnratedLeague,
  FORTYMM_LEAGUE_ID,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor } from '@/test/utilities'

import { leaguesCardQuery, type LeaguesView } from './leagues-card-query'
import { leaguesCardQueryPage } from './leagues-card-query.page'

/** Resolve the query against one bundle, asking for `leagueId`, and hand back the
 * projected view. `undefined` is the default league — a URL with no `?league=`. */
async function selectFrom(
  overrides: Parameters<typeof buildPlayerDetail>[0],
  leagueId?: string,
): Promise<LeaguesView> {
  leaguesCardQueryPage.mockEndpoint(() =>
    HttpResponse.json(buildPlayerDetail(overrides)),
  )
  const { result } = leaguesCardQueryPage.render(leagueId)
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  return result.current.data!
}

describe('leaguesCardQuery', () => {
  it('lists every league the player is in, with their rating ON each', async () => {
    const view = await selectFrom({})

    expect(view.rows.map((row) => [row.name, row.rating])).toEqual([
      ['FortyMM', '1687'],
      ['USATT', '1642'],
    ])
  })

  it('says NOTHING about which row is selected — that is the URL’s business, not the response’s', async () => {
    // The bundle carries the same `leagues` list whichever league was asked for,
    // so selection is not a fact this projection can know. It lives in the card,
    // off the `leagueId` prop — which is what lets `select` be a stable, payload-
    // only function (see the identity test below).
    const view = await selectFrom({}, USATT_LEAGUE_ID)

    expect(view.rows.some((row) => 'isSelected' in row)).toBe(false)
  })

  it('hands TanStack the SAME select fn whatever the league — an inline arrow would re-project on every render', () => {
    // TanStack memoizes `select` on its *identity*. A `select` closing over
    // `leagueId` is rebuilt on every call, so the memo never hits and the whole
    // view model is recomputed on every render of the card. Every other card on
    // this page passes a stable module-level ref; this one now does too.
    expect(leaguesCardQuery('p-1', USATT_LEAGUE_ID).select).toBe(
      leaguesCardQuery('p-1', FORTYMM_LEAGUE_ID).select,
    )
  })

  it('flags the default league, and only the default league', async () => {
    const view = await selectFrom({})

    expect(view.rows.map((row) => row.isDefault)).toEqual([true, false])
  })

  it('prints an em dash — NEVER a 0 — for a league the player holds no rating in', async () => {
    // Belonging to a ladder and holding a rating on it are different facts (the
    // API outer-joins the rating). A 0 would say they are the worst player on it;
    // borrowing the *other* league's rating would say they have one rating, which
    // is the exact claim ADR-0915 says is false.
    const view = await selectFrom({
      leagues: [buildDefaultLeague(), buildUnratedLeague()],
    })

    expect(view.rows[1].rating).toBe('—')
    expect(view.rows[1].rating).not.toBe('0')
    expect(view.rows[1].rating).not.toBe('1687')
  })

  it('rounds a rating to whole points', async () => {
    const view = await selectFrom({
      leagues: [buildDefaultLeague({ rating: 1687.4 })],
    })

    expect(view.rows[0].rating).toBe('1687')
  })

  it('renders the single-league player every real user is today', async () => {
    const view = await selectFrom({
      leagues: [buildDefaultLeague()],
    })

    expect(view.rows).toHaveLength(1)
    expect(view.rows[0].name).toBe('FortyMM')
  })

  it('keeps the league in the CACHE KEY — a switch re-keys the bundle and refetches', async () => {
    // This is the switcher's whole mechanism (ADR-0915): the league is part of
    // the profile bundle's key, so picking one refetches the hero, the rating
    // panel, the confidence card and this card's highlight in ONE request. Two
    // leagues sharing a key would leave the page showing the old ladder's rating.
    expect(leaguesCardQuery('p-1', USATT_LEAGUE_ID).queryKey).not.toEqual(
      leaguesCardQuery('p-1', FORTYMM_LEAGUE_ID).queryKey,
    )
  })

  it('reads the same cache entry as the profile bundle — no second request', () => {
    // Both with and without a league: every card on the page must key identically
    // or the profile forks into two requests.
    expect(leaguesCardQuery('p-1').queryKey).toEqual(
      playerByIdQueryOptions('p-1').queryKey,
    )
    expect(leaguesCardQuery('p-1', USATT_LEAGUE_ID).queryKey).toEqual(
      playerByIdQueryOptions('p-1', USATT_LEAGUE_ID).queryKey,
    )
  })

  it('sends the league to the API as `league_id`', async () => {
    // The projection can look right while the wire is wrong: if the request goes
    // out without `league_id`, the API answers with the DEFAULT league's rating
    // and the hero silently shows the wrong ladder's numbers under the right
    // highlight.
    let requestedUrl = ''
    leaguesCardQueryPage.mockEndpoint(({ request }) => {
      requestedUrl = request.url
      return HttpResponse.json(buildPlayerDetail({}))
    })
    const { result } = leaguesCardQueryPage.render(USATT_LEAGUE_ID)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(new URL(requestedUrl).searchParams.get('league_id')).toBe(
      USATT_LEAGUE_ID,
    )
  })

  it('sends NO `league_id` for the default league — the clean URL is the clean request', async () => {
    let requestedUrl = ''
    leaguesCardQueryPage.mockEndpoint(({ request }) => {
      requestedUrl = request.url
      return HttpResponse.json(buildPlayerDetail({}))
    })
    const { result } = leaguesCardQueryPage.render(undefined)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(new URL(requestedUrl).searchParams.has('league_id')).toBe(false)
  })

  it('says nothing per-league about CAREER — there is nothing per-league to say', async () => {
    // Career is cross-league (ADR-0915). A W–L on these rows would imply the
    // Career card moves when you click a ladder. It does not.
    const view = await selectFrom({
      leagues: [buildDefaultLeague(), buildSecondLeague()],
    })

    expect(Object.keys(view.rows[0]).sort()).toEqual([
      'id',
      'isDefault',
      'name',
      'rating',
    ])
  })
})
