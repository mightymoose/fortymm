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
    // (The name IS a link — to the profile it promises. See below.)
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    const link = matchHistoryRowPage.getDetailLink(OPPONENT)
    const date = link.textContent ?? ''
    expect(date).not.toBe('')
    expect(link).toHaveAccessibleName(`Match against ${OPPONENT}, ${date}`)
  })

  it("links the opponent's name to that opponent's profile (#1005)", async () => {
    // The history named its opponents in plain text — the most obvious next step
    // from a list of the people you have played, and there was nothing to click.
    // The id was on the wire the whole time; the row now spends it.
    matchHistoryRowPage.render({
      match: buildPlayerMatchRow({
        opponent: { id: 'p-42', username: 'grace.hopper' },
      }),
    })
    await matchHistoryRowPage.findRow('grace.hopper')

    expect(matchHistoryRowPage.getOpponentLink('grace.hopper')).toHaveAttribute(
      'href',
      '/players/p-42',
    )
  })

  it('lifts the opponent’s name ABOVE the row link’s stretched overlay', async () => {
    // The row's anchor paints a `::after` over every cell (`match-row-link.css`),
    // so a control inside a row is unclickable unless it lifts itself out. The
    // name announces, tabs and Enters correctly either way — only the *pointer*
    // breaks, which is precisely what a role-based query cannot see. jsdom loads
    // no stylesheet and can measure no hit-test, so what is pinned here is the
    // hook the stylesheet keys on; the click itself is a browser fact, covered in
    // `web-client/e2e/players/player-profile.spec.ts`.
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    expect(matchHistoryRowPage.getOpponentLink(OPPONENT)).toHaveClass(
      'match-row-inline-link',
    )
  })

  it('exposes exactly TWO links per row — the match, and the opponent', async () => {
    // The match anchor is stretched over the row with a `::after` so the row
    // clicks through end-to-end; a screen reader must hear it ONCE, not once per
    // cell. The opponent's name is the row's second link — a different
    // destination (#1005), with a name of its own — not the same link twice.
    matchHistoryRowPage.render()
    await matchHistoryRowPage.findRow(OPPONENT)

    const links = matchHistoryRowPage.getRowLinks(OPPONENT)
    expect(links).toHaveLength(2)
    // In DOM order: the Date cell comes first, the Opponent cell second.
    expect(links[0]).toHaveAttribute('href', HISTORY_MATCH_HREF)
    expect(links[0].getAttribute('aria-label')).toMatch(
      /^Match against ada\.lovelace, /,
    )
    expect(links[1]).toHaveAttribute('href', '/players/p-9')
    expect(links[1]).toHaveAccessibleName('ada.lovelace')
  })

  it('does NOT link a solo match to a PLAYER — there is nobody to link to', async () => {
    // `id` is null exactly for the player-less sentinel side, so a link built from
    // it would point at `/players/null` and land the reader on a not-found page.
    // "No opponent" is an absence, not a person: plain text. The row still opens
    // its match — that is the one link it has.
    matchHistoryRowPage.render({ match: buildSoloMatchRow() })
    await matchHistoryRowPage.findRow('No opponent')

    expect(matchHistoryRowPage.queryOpponentLink('No opponent')).toBeNull()
    expect(matchHistoryRowPage.getRow('No opponent').innerHTML).not.toContain(
      '/players/',
    )
    expect(matchHistoryRowPage.getRowLinks('No opponent')).toHaveLength(1)
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
