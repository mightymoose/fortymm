import { HttpResponse } from 'msw'

import { matchDetailRoute } from '@/api/matches'
import { playerByIdQueryOptions, type PlayerMatchRow } from '@/api/players'
import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import {
  buildAwaitingMatchRow,
  buildFirstRatedMatchRow,
  buildLiveMatchRow,
  buildLossMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
  buildSoloMatchRow,
  buildUnratedWinMatchRow,
  buildUpNextMatchRow,
  buildVoidedMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import { waitFor } from '@/test/utilities'

import {
  recentMatchesQuery,
  selectRecentMatches,
  type RecentMatchRowView,
  type RecentMatchesView,
} from './recent-matches-query'
import { recentMatchesQueryPage } from './recent-matches-query.page'

/** Resolve the query against one bundle and hand back the projected view. */
async function selectFrom(
  overrides: Parameters<typeof buildPlayerDetail>[0],
): Promise<RecentMatchesView> {
  recentMatchesQueryPage.mockEndpoint(() =>
    HttpResponse.json(buildPlayerDetail(overrides)),
  )
  const { result } = recentMatchesQueryPage.render()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  return result.current.data!
}

/** The projected view of a single wire row. */
async function selectRow(row: PlayerMatchRow): Promise<RecentMatchRowView> {
  const view = await selectFrom({ matches: buildPlayerMatchList([row]) })
  return view.rows[0]
}

describe('recentMatchesQuery', () => {
  it('projects every match the bundle carries — a live one is not dropped', async () => {
    // The list is all-inclusive (ADR-0008). A match in play is neither a win nor
    // a loss; filtering it out would make the card lie about what happened.
    const view = await selectFrom({
      matches: buildPlayerMatchList([
        buildPlayerMatchRow(),
        buildLiveMatchRow(),
        buildAwaitingMatchRow(),
        buildUpNextMatchRow(),
        buildVoidedMatchRow(),
        buildSoloMatchRow(),
      ]),
    })

    expect(view.rows).toHaveLength(6)
    expect(view.rows.map((row) => row.status.tone)).toEqual([
      'won',
      'live',
      'awaiting',
      'up_next',
      'voided',
      'won',
    ])
  })

  it('caps the drawn rows at six, however long a bundle it is handed', () => {
    // The six-row shape is the API's contract (`PROFILE_RECENT_MATCHES`), but the
    // card owns its own drawing: hand the projection an over-long bundle — 25
    // rows — and it must still yield exactly six, never a long table. Drop the
    // `.slice` and this reds with 25.
    const bundle = buildPlayerDetail({
      matches: buildPlayerMatchList(
        Array.from({ length: 25 }, () => buildPlayerMatchRow()),
      ),
    })

    expect(selectRecentMatches(bundle).rows).toHaveLength(6)
  })

  it('names the footer link with the all-inclusive total, not the decided count', async () => {
    // 24 wins + 11 losses = 35 decided, but 50 matches exist — the extra fifteen
    // are in play, voided or unrated. The link names *fifty* (ADR-0915: the two
    // totals differ on purpose; reconciling them is the bug).
    const view = await selectFrom({ wins: 24, losses: 11, match_total: 50 })

    expect(view.total).toBe(50)
    expect(view.viewAllLabel).toBe('View all 50 matches')
  })

  it('drops the count and "all" for a lone match — "View all 1 match" reads wrong', async () => {
    const view = await selectFrom({ match_total: 1 })

    expect(view.viewAllLabel).toBe('View match')
  })

  it('carries the player id the history link needs', async () => {
    const view = await selectFrom({ id: 'p-7' })

    expect(view.playerId).toBe('p-7')
  })

  it('reads a decided rated win as a won dot, its game chips and a signed delta', async () => {
    const row = await selectRow(buildPlayerMatchRow())

    expect(row.status).toEqual({ tone: 'won', label: 'Won' })
    expect(row.score).toEqual({
      kind: 'games',
      games: [
        { mine: 11, theirs: 7, won: true },
        { mine: 9, theirs: 11, won: false },
        { mine: 11, theirs: 6, won: true },
      ],
    })
    expect(row.delta).toEqual({
      label: '+12',
      ariaLabel: 'Gained 12 rating',
      tone: 'win',
    })
    expect(row.when).toBe('Mar 14')
  })

  it('signs a losing delta', async () => {
    const row = await selectRow(buildLossMatchRow())

    expect(row.status.tone).toBe('lost')
    expect(row.delta?.label).toBe('-14')
    expect(row.delta?.tone).toBe('loss')
  })

  it('shows an em dash for the match that ESTABLISHED the rating', async () => {
    // A *present* rating change whose `delta` is null: the player's first rated
    // match. It gave them a rating (1268); it did not move one. The Δ column
    // measures movement, so it reads `—` — never a "−232" off the 1500 their
    // league-join seeded, and never a "+0" (#952). The row still reports its
    // result and its score: the match was decided, it just moved no rating.
    const row = await selectRow(buildFirstRatedMatchRow())

    expect(row.delta).toBeNull()
    expect(row.status).toEqual({ tone: 'lost', label: 'Lost' })
    expect(row.score.kind).toBe('games')
  })

  it('keeps the two nulls apart — an unrated match and a first rated one both read "—" but are not the same row', async () => {
    // If someone collapsed `rating_change === null` and `delta === null` into one
    // branch, this pair would still pass on the Δ column alone — so it also pins
    // what distinguishes them: the established row *carries* a change, and its
    // `after` is the rating the player now holds.
    const unrated = buildUnratedWinMatchRow()
    const established = buildFirstRatedMatchRow()

    expect(unrated.rating_change).toBeNull()
    expect(established.rating_change).not.toBeNull()
    expect(established.rating_change?.delta).toBeNull()
    expect(established.rating_change?.before).toBeNull()
    expect(established.rating_change?.after).toBe(1268)

    expect((await selectRow(unrated)).delta).toBeNull()
    expect((await selectRow(established)).delta).toBeNull()
  })

  it('reports a live match as Live — no score, no delta', async () => {
    // The wire row already has a game on the board. It is not a result: the card
    // must not print a scoreline for a match that hasn't finished.
    const row = await selectRow(buildLiveMatchRow())

    expect(row.status).toEqual({ tone: 'live', label: 'Live' })
    expect(row.score).toEqual({ kind: 'text', text: 'Live' })
    expect(row.delta).toBeNull()
  })

  it('tells an awaiting-acceptance match apart from a live one', async () => {
    // Both sit at `in_progress` on the wire — only the flag separates them
    // (#364), and it is checked first.
    const row = await selectRow(buildAwaitingMatchRow())

    expect(row.status).toEqual({
      tone: 'awaiting',
      label: 'Awaiting acceptance',
    })
    expect(row.score).toEqual({ kind: 'text', text: 'Awaiting' })
    expect(row.delta).toBeNull()
  })

  it('reports an up-next match with an em dash where the score would go', async () => {
    const row = await selectRow(buildUpNextMatchRow())

    expect(row.status).toEqual({ tone: 'up_next', label: 'Up next' })
    expect(row.score).toEqual({ kind: 'text', text: '—' })
    expect(row.delta).toBeNull()
  })

  it('keeps a voided match, and lets it decide nothing', async () => {
    const row = await selectRow(buildVoidedMatchRow())

    expect(row.status).toEqual({ tone: 'voided', label: 'Voided' })
    expect(row.score).toEqual({ kind: 'text', text: '—' })
    expect(row.delta).toBeNull()
  })

  it('has NO delta — not a "+0" — for a decided but UNRATED win', async () => {
    // The specific bug ADR-0915 calls out: this row is completed and won, so a
    // status-driven Δ would happily print "+0". The delta keys off
    // `rating_change` alone, which is null — nothing moved.
    const row = await selectRow(buildUnratedWinMatchRow())

    expect(row.status.tone).toBe('won')
    expect(row.score.kind).toBe('games')
    expect(row.delta).toBeNull()
  })

  it('carries the opponent’s id, so the row can link to their profile', async () => {
    // The id was on the wire all along — the projection dropped it, and that is
    // the whole reason every opponent's name on this card was a dead end.
    const row = await selectRow(
      buildPlayerMatchRow({
        opponent: { id: 'p-42', username: 'grace.hopper' },
      }),
    )

    expect(row.opponent).toEqual({
      kind: 'player',
      id: 'p-42',
      name: 'grace.hopper',
    })
  })

  it('renders the solo sentinel as "No opponent" rather than dropping the match', async () => {
    const row = await selectRow(buildSoloMatchRow())

    expect(row.opponent).toEqual({ kind: 'solo', name: 'No opponent' })
  })

  it('gives the solo sentinel NO id — there is nobody to link to', async () => {
    // The null-id case, stated as a type-level fact rather than a rendering one:
    // `id` exists only on the `player` variant, so nothing downstream can build
    // `/players/null` out of a solo row — the link is unbuildable, not merely
    // unbuilt. (The wire nulls `id` and `username` together for the player-less
    // sentinel side of a solo match, ADR-0008.)
    const row = await selectRow(buildSoloMatchRow())

    expect(row.opponent.kind).toBe('solo')
    expect(row.opponent).not.toHaveProperty('id')
  })

  it('will not link an opponent the payload named but did not identify', async () => {
    // `PlayerMatchOpponent` nulls its two fields independently on the wire, so a
    // username without an id is *typable* even though the API never sends it. It
    // is the one shape that could still produce `/players/undefined`, so the
    // projection demands BOTH halves before it calls someone a linkable player:
    // drop the id check and this row would carry `id: undefined` into a <Link>.
    const row = await selectRow(
      buildPlayerMatchRow({ opponent: { id: null, username: 'ada.lovelace' } }),
    )

    expect(row.opponent.kind).toBe('solo')
  })

  it('is empty, and offers nothing to view, for a player with no matches', async () => {
    const view = await selectFrom({
      match_total: 0,
      matches: buildPlayerMatchList([]),
    })

    expect(view.rows).toEqual([])
    expect(view.total).toBe(0)
  })

  it('dates a match in the READER’s day — never in UTC', () => {
    // The day you played a match is a LOCAL fact, and every other surface renders
    // it that way (the full history page, the match detail page). This card used to
    // format in UTC, so a match played at 7:15pm in Chicago — already tomorrow in
    // UTC — was dated a day ahead of both, and two matches played fifteen minutes
    // apart could land on two different days *in the same table*.
    //
    // (Contrast the hero's "Member since", which stays UTC on purpose: a join
    // *month* is a fact about the account, not about the reader's evening.)
    //
    // ONE instant, read from two zones — 00:15 UTC on Jul 12 is still the evening of
    // Jul 11 in Chicago, and already Jul 12 in Tokyo. So this pins the claim itself
    // ("the day is computed in the given zone") rather than a day-label that only
    // reads correctly from certain longitudes: format in UTC and Chicago reds; hardwire
    // any single zone and the other reds. And it says so with NO ambient `TZ` and no
    // `vi.stubEnv` — the zone is an argument. (An env-stubbed version of this test
    // passed under vitest and failed under Stryker's runner, which doesn't honour a
    // mid-test `process.env.TZ`; a test that can only run in one runner is not a test.)
    const bundle = buildPlayerDetail({
      matches: buildPlayerMatchList([
        buildPlayerMatchRow({ created_at: '2026-07-12T00:15:00Z' }),
      ]),
    })

    expect(selectRecentMatches(bundle, 'America/Chicago').rows[0].when).toBe('Jul 11')
    expect(selectRecentMatches(bundle, 'Asia/Tokyo').rows[0].when).toBe('Jul 12')
  })

  it('hands the projection to `select` unwrapped, so the reader’s own zone is the one used', () => {
    // The counterpart to the test above: it proves the projection honours the zone it
    // is GIVEN, and this proves production gives it none. An omitted `timeZone` is what
    // `Intl` reads as "the runtime's zone", so React Query calling `select(data)` with
    // the bare projection is precisely what makes the card date in the reader's day.
    // Wrapping it — `select: (p) => selectRecentMatches(p, 'UTC')` — is how the original
    // bug would come back, and no rendered assertion can catch that on a UTC CI box,
    // where local and UTC are the same day. This can.
    expect(recentMatchesQuery('p-1').select).toBe(selectRecentMatches)
  })

  it('prints an em dash rather than "Invalid Date" for an unreadable timestamp', async () => {
    const row = await selectRow(buildPlayerMatchRow({ created_at: 'not-a-date' }))

    expect(row.when).toBe('—')
  })

  it('reads the same cache entry as the profile bundle — no second request', () => {
    expect(recentMatchesQuery('p-1').queryKey).toEqual(
      playerByIdQueryOptions('p-1').queryKey,
    )
  })

  it('points each row at ITS match, through the typed route factory (#989)', async () => {
    // The row is a link now, and the target is derived data — so it is derived
    // here, from `matchDetailRoute`, rather than hand-written as a path in the
    // row component. A real match id: the `$matchId` route guard
    // (`src/lib/match-id.ts`) only accepts a UUID.
    const id = '5b1d3f7a-2c94-4e08-8a6d-19f4b7c02e35'
    const row = await selectRow(buildPlayerMatchRow({ id }))

    expect(row.detailRoute).toEqual(matchDetailRoute(id))
    expect(row.detailRoute).toEqual({
      to: '/matches/$matchId',
      params: { matchId: id },
    })
  })

  it('names the link after the MATCH — the opponent and the day it was played', async () => {
    // The anchor sits on the date cell, not on the opponent's name: a link
    // announced as "ada.lovelace" promises a profile and delivers a match. So the
    // label says what actually opens.
    const row = await selectRow(buildPlayerMatchRow())

    expect(row.ariaLabel).toBe('Match against ada.lovelace, Mar 14')
  })

  it('names a solo match’s link "Solo match" — nobody is "against" the sentinel side', async () => {
    const row = await selectRow(buildSoloMatchRow())

    expect(row.ariaLabel).toBe('Solo match, Mar 14')
    expect(row.ariaLabel).not.toContain('No opponent')
  })

  it('keeps the link’s spoken date and the printed one the same', async () => {
    // Both come off the one `when` the row already carries, so a match dated in
    // the reader's zone cannot be announced in another. (The Chicago/Tokyo pair
    // above pins the zone itself; this pins that the label follows it.)
    const bundle = buildPlayerDetail({
      matches: buildPlayerMatchList([
        buildPlayerMatchRow({ created_at: '2026-07-12T00:15:00Z' }),
      ]),
    })

    const chicago = selectRecentMatches(bundle, 'America/Chicago').rows[0]
    expect(chicago.when).toBe('Jul 11')
    expect(chicago.ariaLabel).toContain('Jul 11')
  })
})
