import { matchDetailRoute } from '@/api/matches'

import {
  MATCH_HREF,
  MATCH_ID,
  buildMatchRowLinkProps,
} from './match-row-link.factory'
import { matchRowLinkPage } from './match-row-link.page'
import { matchRowAriaLabel } from './match-row-naming'

describe('MatchRowLink', () => {
  it('is a real anchor at /matches/<id> — not a role="link" <tr> with an onClick', async () => {
    // The point of #989: an `href`. A `role="link"` row cannot be cmd-clicked,
    // middle-clicked or opened in a new tab, and has to hand-roll its own
    // preloading. Asserting "a link exists" would pass for that broken idiom too,
    // so this asserts the URL.
    matchRowLinkPage.render()

    const link = await matchRowLinkPage.findMatchLink()
    expect(link).toHaveAttribute('href', MATCH_HREF)
    expect(MATCH_HREF).toBe(`/matches/${MATCH_ID}`)
  })

  it('names the MATCH, not the opponent, for a screen reader', async () => {
    // A link around "ada.lovelace" announces as "go to ada.lovelace's profile" —
    // which is not where it goes. The date cell carries the anchor, and the label
    // says what opens.
    matchRowLinkPage.render()

    const link = await matchRowLinkPage.findMatchLink()
    expect(link).toHaveAccessibleName('Match against ada.lovelace, Mar 14')
    expect(link).toHaveTextContent('Mar 14')
  })

  it('exposes exactly ONE link per row', async () => {
    // The anchor is stretched over the whole row with a `::after`, precisely so
    // that the row can be clickable end-to-end without a screen reader hearing
    // four identical links.
    matchRowLinkPage.render()

    await matchRowLinkPage.findMatchLink()
    expect(matchRowLinkPage.getAllLinks()).toHaveLength(1)
  })

  it('carries the class the stretch + focus ring key off', async () => {
    // jsdom has no layout engine and vitest loads no stylesheet, so no test here
    // can measure the stretched hit area — the `::after` and the row's focus
    // outline are browser facts (hit-tested by hand across a real row: the anchor
    // answers at 5%…95% of its width, and a click in the score cell navigates).
    // What a test CAN pin is the hook the CSS knows the anchor by: rename it here
    // without renaming it there and the row silently stops being clickable
    // outside the date text.
    matchRowLinkPage.render()

    expect(await matchRowLinkPage.findMatchLink()).toHaveClass('match-row-link')
  })

  it('reads a solo match as "Solo match", never "Match against No opponent"', () => {
    // The player-less sentinel side (ADR-0008) has nobody to be "against".
    expect(
      matchRowAriaLabel({
        opponent: 'No opponent',
        isSolo: true,
        when: 'Mar 14',
      }),
    ).toBe('Solo match, Mar 14')
  })

  it('names an opposed match after the opponent and the day it was played', () => {
    expect(
      matchRowAriaLabel({
        opponent: 'ada.lovelace',
        isSolo: false,
        when: 'Mar 14',
      }),
    ).toBe('Match against ada.lovelace, Mar 14')
  })

  it('takes its target from the typed route factory, not a hand-written path', () => {
    // `matchDetailRoute` is the one place the `/matches/$matchId` shape is
    // spelled out; a hand-rolled `to` string would drift from it silently.
    expect(buildMatchRowLinkProps().route).toEqual(matchDetailRoute(MATCH_ID))
  })
})
