import {
  buildAwaitingMatchRow,
  buildLiveMatchRow,
  buildPlayerMatchRow,
  buildSoloMatchRow,
  buildUpNextMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'

import {
  HISTORY_MATCH_HREF,
  HISTORY_MATCH_ID,
  buildMatchHistoryRowProps,
} from './match-history-row.factory'
import { matchHistoryRowPage } from './match-history-row.page'

const OPPONENT = 'ada.lovelace'

describe('MatchHistoryRow', () => {
  it('links the row through to the match — a real href, not a role="link" row (#989)', async () => {
    // The whole point of #989: an `href`. A `role="link"` `<tr>` with an onClick
    // cannot be cmd-clicked, middle-clicked or opened in a new tab. Asserting
    // "there is a link" would pass for that broken idiom too, so this asserts the
    // URL — and the id in it is a UUID, which is what the `$matchId` route guard
    // (`src/lib/match-id.ts`) will actually accept.
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    expect(matchHistoryRowPage.getDetailLink(OPPONENT)).toHaveAttribute(
      'href',
      HISTORY_MATCH_HREF,
    )
    expect(HISTORY_MATCH_HREF).toBe(`/matches/${HISTORY_MATCH_ID}`)
  })

  it('points each row at its OWN match', async () => {
    // A hardcoded target would sail through the test above.
    const id = 'ac47f0d2-19b8-4e35-8f61-0d7c3a5b9e24'
    matchHistoryRowPage.render({
      match: buildPlayerMatchRow({ id }),
    })
    await matchHistoryRowPage.findRow(OPPONENT)

    expect(matchHistoryRowPage.getDetailLink(OPPONENT)).toHaveAttribute(
      'href',
      `/matches/${id}`,
    )
  })

  it('puts the anchor on the DATE cell and names it for the match', async () => {
    // Not on the opponent's name: a link announced as "ada.lovelace" promises a
    // profile and delivers a match. The visible text is the date the row already
    // printed, and the spoken name is built from it — so the two cannot drift.
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    const link = matchHistoryRowPage.getDetailLink(OPPONENT)
    const date = link.textContent ?? ''
    expect(date).not.toBe('')
    expect(link).toHaveAccessibleName(`Match against ${OPPONENT}, ${date}`)
  })

  it('exposes exactly ONE link per row', async () => {
    // The anchor is stretched over the row with a `::after` so the row clicks
    // through end-to-end; a screen reader must still hear one link, not four.
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    expect(matchHistoryRowPage.getRowLinks(OPPONENT)).toHaveLength(1)
  })

  it('links a solo match too, named "Solo match" (ADR-0008)', async () => {
    // The player-less sentinel side is rendered, not dropped — and it is a real
    // match, so it opens. Nobody is "against" it, so the label doesn't pretend.
    const id = 'c1e5a70b-3d46-4b92-a0f7-8e2d1c9b4f60'
    matchHistoryRowPage.render({ match: buildSoloMatchRow({ id }) })
    await matchHistoryRowPage.findRow('No opponent')

    const link = matchHistoryRowPage.getDetailLink('No opponent')
    expect(link).toHaveAttribute('href', `/matches/${id}`)
    expect(link.getAttribute('aria-label')).toMatch(/^Solo match, /)
    expect(link.getAttribute('aria-label')).not.toContain('No opponent')
  })

  it('renders one score chip per game, from the player’s perspective', async () => {
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    const chips = matchHistoryRowPage.getGameChips(OPPONENT)
    expect(chips).toHaveLength(3)
    expect(chips[0]).toHaveClass('player-profile__game--won')
    expect(chips[1]).toHaveClass('player-profile__game--lost')
    expect(chips[2]).toHaveClass('player-profile__game--won')
  })

  it('chips a decided win WIN', async () => {
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    expect(matchHistoryRowPage.getResultChip(OPPONENT)).toHaveTextContent('WIN')
  })

  it('tells an awaiting-acceptance match apart from a live one (#364)', async () => {
    // Both sit at `in_progress` on the wire; only the flag separates them.
    matchHistoryRowPage.render({ match: buildAwaitingMatchRow() })
    await matchHistoryRowPage.findRow(OPPONENT)
    expect(matchHistoryRowPage.getResultChip(OPPONENT)).toHaveTextContent(
      'AWAITING',
    )
  })

  it('chips a live match LIVE', async () => {
    matchHistoryRowPage.render({ match: buildLiveMatchRow() })
    await matchHistoryRowPage.findRow(OPPONENT)

    expect(matchHistoryRowPage.getResultChip(OPPONENT)).toHaveTextContent('LIVE')
  })

  it('chips an up-next match UP NEXT, with an em dash where the score would go', async () => {
    matchHistoryRowPage.render({ match: buildUpNextMatchRow() })
    await matchHistoryRowPage.findRow(OPPONENT)

    expect(matchHistoryRowPage.getResultChip(OPPONENT)).toHaveTextContent(
      'UP NEXT',
    )
    expect(matchHistoryRowPage.getGameChips(OPPONENT)).toHaveLength(0)
    expect(matchHistoryRowPage.getRow(OPPONENT)).toHaveTextContent('—')
  })

  it('takes its props from the factory’s default wire row', () => {
    expect(buildMatchHistoryRowProps().match.id).toBe(HISTORY_MATCH_ID)
  })
})
