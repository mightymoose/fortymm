import { HttpResponse } from 'msw'

import { playerByIdQueryOptions, type PlayerMatchRow } from '@/api/players'
import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import {
  buildAwaitingMatchRow,
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

  it('names the footer link with the all-inclusive total, not the decided count', async () => {
    // 24 wins + 11 losses = 35 decided, but 50 matches exist — the extra fifteen
    // are in play, voided or unrated. The link names *fifty* (ADR-0915: the two
    // totals differ on purpose; reconciling them is the bug).
    const view = await selectFrom({ wins: 24, losses: 11, match_total: 50 })

    expect(view.total).toBe(50)
    expect(view.viewAllLabel).toBe('View all 50 matches')
  })

  it('says "match", singular, when there is only one', async () => {
    const view = await selectFrom({ match_total: 1 })

    expect(view.viewAllLabel).toBe('View all 1 match')
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

  it('renders the solo sentinel as "No opponent" rather than dropping the match', async () => {
    const row = await selectRow(buildSoloMatchRow())

    expect(row.opponent).toBe('No opponent')
    expect(row.isSolo).toBe(true)
  })

  it('is empty, and offers nothing to view, for a player with no matches', async () => {
    const view = await selectFrom({
      match_total: 0,
      matches: buildPlayerMatchList([]),
    })

    expect(view.rows).toEqual([])
    expect(view.total).toBe(0)
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
})
