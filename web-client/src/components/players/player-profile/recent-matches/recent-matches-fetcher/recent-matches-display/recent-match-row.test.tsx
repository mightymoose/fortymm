import {
  LIVE_MATCH_ID,
  RECENT_MATCH_HREF,
  SOLO_MATCH_ID,
  buildLiveRecentMatchRowView,
  buildRecentMatchDeltaView,
  buildRecentMatchGameView,
  buildRecentMatchOpponentView,
  buildRecentMatchRowView,
  buildRecentMatchStatusView,
  buildSoloRecentMatchRowView,
} from './recent-match-row.factory'
import { recentMatchRowPage } from './recent-match-row.page'

const OPPONENT = 'ada.lovelace'
const NO_OPPONENT = 'No opponent'

describe('RecentMatchRow', () => {
  it('renders a decided win as a green dot, its game chips and a signed delta', async () => {
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })

    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveAccessibleName(
      'Won',
    )
    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveClass(
      'recent-matches__dot--won',
    )
    expect(recentMatchRowPage.getScoreCell(OPPONENT)).toHaveTextContent(
      '117911116',
    )
    expect(recentMatchRowPage.getDeltaCell(OPPONENT)).toHaveTextContent('+12')
    expect(recentMatchRowPage.getWhenCell(OPPONENT)).toHaveTextContent('Mar 14')
  })

  it('tones a losing delta as a loss and names it for a screen reader', async () => {
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({
        status: buildRecentMatchStatusView({ tone: 'lost', label: 'Lost' }),
        delta: buildRecentMatchDeltaView({
          label: '-14',
          ariaLabel: 'Lost 14 rating',
          tone: 'loss',
        }),
      }),
    })

    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveClass(
      'recent-matches__dot--lost',
    )
    expect(recentMatchRowPage.getDeltaCell(OPPONENT)).toHaveTextContent('-14')
    expect(
      recentMatchRowPage.getDeltaCell(OPPONENT).querySelector('[role="img"]'),
    ).toHaveAccessibleName('Lost 14 rating')
  })

  it('carries a live match on its dot and in the score cell — never a score', async () => {
    // The result chip is gone: if the dot and the score cell don't say "Live",
    // nothing does.
    recentMatchRowPage.render({ row: buildLiveRecentMatchRowView() })

    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveAccessibleName(
      'Live',
    )
    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveClass(
      'recent-matches__dot--live',
    )
    expect(recentMatchRowPage.getScoreCell(OPPONENT)).toHaveTextContent('Live')
  })

  it('prints an em dash — never "+0" — when no rating moved', async () => {
    recentMatchRowPage.render({ row: buildRecentMatchRowView({ delta: null }) })

    await recentMatchRowPage.findRow(OPPONENT)

    const delta = recentMatchRowPage.getDeltaCell(OPPONENT)
    expect(delta).toHaveTextContent('—')
    expect(delta).not.toHaveTextContent('0')
    expect(delta.querySelector('[role="img"]')).toHaveAccessibleName(
      'No rating change',
    )
  })

  it('marks the games the player lost apart from the ones they won', async () => {
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({
        score: {
          kind: 'games',
          games: [
            buildRecentMatchGameView({ mine: 11, theirs: 7, won: true }),
            buildRecentMatchGameView({ mine: 9, theirs: 11, won: false }),
          ],
        },
      }),
    })

    await recentMatchRowPage.findRow(OPPONENT)

    const chips = recentMatchRowPage
      .getScoreCell(OPPONENT)
      .querySelectorAll('.player-profile__game')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveClass('player-profile__game--won')
    expect(chips[1]).toHaveClass('player-profile__game--lost')
  })

  it("links the opponent's name to that opponent's profile", async () => {
    // The card named its opponents in plain text — the most obvious next step on
    // the page, and there was nothing to click. The id was on the wire the whole
    // time; the row now spends it.
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({
        opponent: buildRecentMatchOpponentView({
          id: 'p-42',
          name: 'grace.hopper',
        }),
      }),
    })

    await recentMatchRowPage.findRow('grace.hopper')

    expect(recentMatchRowPage.getOpponentLink('grace.hopper')).toBeVisible()
    expect(recentMatchRowPage.getOpponentHref('grace.hopper')).toBe(
      '/players/p-42',
    )
  })

  it('lifts the opponent’s name ABOVE the row link’s stretched overlay', async () => {
    // The row's anchor paints a `::after` over every cell (`match-row-link.css`),
    // so a control inside a row is unclickable unless it lifts itself out. The
    // name announces, tabs and Enters correctly either way — only the *pointer*
    // breaks — which is exactly the kind of regression a role-based query cannot
    // see. jsdom loads no stylesheet and can measure no hit-test, so what is
    // asserted here is the hook the stylesheet keys on; the click itself is a
    // browser fact, pinned in `web-client/e2e/players/player-profile.spec.ts`.
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })

    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getOpponentLink(OPPONENT)).toHaveClass(
      'match-row-inline-link',
    )
  })

  it('keeps a solo match in the list, as "No opponent"', async () => {
    // ADR-0008: the player-less sentinel side is rendered, not dropped.
    recentMatchRowPage.render({ row: buildSoloRecentMatchRowView() })

    await recentMatchRowPage.findRow(NO_OPPONENT)

    expect(recentMatchRowPage.getRow(NO_OPPONENT)).toBeInTheDocument()
    expect(recentMatchRowPage.getStatusDot(NO_OPPONENT)).toBeInTheDocument()
  })

  it('does NOT link a solo match to a PLAYER — there is nobody to link to', async () => {
    // The null-id case, and the one a naive fix breaks: `id` is null exactly for
    // the player-less sentinel side, so a link built from it would point at
    // `/players/null` and land the reader on a not-found page. "No opponent" is
    // an absence, not a player: it must be plain text.
    //
    // The row still links to its MATCH — a solo match is a match — so the claim is
    // not "no anchors in the row" but "nothing in the row points at a player".
    recentMatchRowPage.render({ row: buildSoloRecentMatchRowView() })

    await recentMatchRowPage.findRow(NO_OPPONENT)

    expect(recentMatchRowPage.queryOpponentLink(NO_OPPONENT)).toBeNull()
    expect(recentMatchRowPage.getRow(NO_OPPONENT).innerHTML).not.toContain(
      '/players/',
    )
    // One link, and it is the match's.
    const links = recentMatchRowPage.getRowLinks(NO_OPPONENT)
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', `/matches/${SOLO_MATCH_ID}`)
  })

  it('links the row through to the match — a real href, not a role="link" row (#989)', async () => {
    // The whole point of #989. A `role="link"` `<tr>` with an onClick cannot be
    // cmd-clicked, middle-clicked or opened in a new tab; only an `href` can. So
    // this asserts the URL, not the existence of a link.
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })
    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getDetailLink(OPPONENT)).toHaveAttribute(
      'href',
      RECENT_MATCH_HREF,
    )
  })

  it('points each row at its OWN match', async () => {
    // A row whose link is hardcoded — or built from the wrong row — would sail
    // through the test above. The live variant is a different match.
    recentMatchRowPage.render({ row: buildLiveRecentMatchRowView() })
    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getDetailLink(OPPONENT)).toHaveAttribute(
      'href',
      `/matches/${LIVE_MATCH_ID}`,
    )
  })

  it('puts the anchor on the DATE cell and names it for the MATCH', async () => {
    // The row's anchor is on the date, not around the opponent's name: a link
    // named "ada.lovelace" announces a profile, and this one delivers a match.
    // The opponent's name IS a link — to the profile it promises (#1005) — which
    // is what makes naming this one for the match the honest choice rather than
    // the only one.
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })
    await recentMatchRowPage.findRow(OPPONENT)

    const link = recentMatchRowPage.getDetailLink(OPPONENT)
    expect(link).toHaveAccessibleName('Match against ada.lovelace, Mar 14')
    expect(recentMatchRowPage.getWhenCell(OPPONENT)).toContainElement(link)
  })

  it('exposes exactly TWO links per row — the match, and the opponent', async () => {
    // Two links a screen reader hears, and they go to two genuinely different
    // places: the row opens the match (#989), the name opens the person (#1005).
    // Each is named for where it actually goes. What must NOT happen is the same
    // link heard once per cell — hence the single stretched anchor.
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })
    await recentMatchRowPage.findRow(OPPONENT)

    const links = recentMatchRowPage.getRowLinks(OPPONENT)
    expect(links).toHaveLength(2)
    expect(
      links.map((link) => [
        link.getAttribute('aria-label') ?? link.textContent,
        link.getAttribute('href'),
      ]),
    ).toEqual([
      // In DOM order: the Opponent cell comes first, the "When" cell last.
      ['ada.lovelace', '/players/p-9'],
      ['Match against ada.lovelace, Mar 14', RECENT_MATCH_HREF],
    ])
  })

  it('names a solo match’s link "Solo match", not "Match against No opponent"', async () => {
    recentMatchRowPage.render({ row: buildSoloRecentMatchRowView() })
    await recentMatchRowPage.findRow(NO_OPPONENT)

    expect(recentMatchRowPage.getDetailLink(NO_OPPONENT)).toHaveAccessibleName(
      'Solo match, Mar 14',
    )
  })
})
