/**
 * The **standings** (ADR-0788), through the real browser: a played-out round-robin
 * group's results table, rendered on the tournament detail below its fixtures, and the
 * champion of a decided event.
 *
 * What only a browser proves here, and why the vitest suite could not:
 *
 *   1. **The results render as a table, joined to names, in the SERVER's order.** The
 *      standings arrive as rows of entry *ids* and numbers; the FE joins each id to a
 *      username off the event's entrants, and renders the rows in the exact order the
 *      server sent them — the order *is* the result (wins → head-to-head → game difference
 *      → games won), and re-sorting client-side would silently disagree with a tiebreak the
 *      client cannot see. A table of raw uuids, or one re-sorted here, would pass a "renders
 *      standings" check and be a lie; this asserts the names, in order.
 *
 *   2. **The champion is shown once the event is decided.** A complete single-group
 *      round-robin has a champion; the callout names them (joined to a username, not an id).
 *
 *   3. **This whole surface runs with MSW OFF.** vitest exercises the component against the
 *      MSW factory; this exercises it against the real bundle and the inline `page.route`
 *      stub, which is the only place a schema/BFF mismatch on the new `results` field would
 *      surface (the stub returns it, the client parses it, the table draws).
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT } from '../page-objects/tournaments/tournaments-store'

/** The drawable seed's JOURNEY event, with its one group played out (`standings: true`):
 * `player.1` (1–0, +2) over `player.2` (0–1, −2), so it is complete with `player.1` its
 * champion. The draw must be cut for the result to sit on a real draw, so JOURNEY is drawn
 * too. */
const STANDINGS_SEED = {
  drawable: true,
  drawn: [EVENT.JOURNEY],
  standings: true,
} as const

test.describe('Tournaments · group standings', () => {
  test('renders a played-out group’s standings table, named and in the server’s order, with the champion', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, STANDINGS_SEED)
    const event = EVENT.JOURNEY

    // The results block is on the card…
    await expect(pom.standingsPanel(event)).toBeVisible()
    await expect(pom.standingsTable(event, 'Group A')).toBeVisible()

    // …with the entrants joined to their NAMES, in the finishing order the server sent —
    // `player.1` (the winner) first, `player.2` second. Not re-sorted, not raw ids.
    await expect(pom.standingsRowNames(event, 'Group A')).toHaveText([
      'player.1',
      'player.2',
    ])

    // The four columns the chore asks for, found by the FULL word a screen reader hears —
    // the terse `W`/`L`/`Diff`/`GW` glyph on screen is aria-hidden, so a header that shipped
    // only the glyph would fail these.
    const table = pom.standingsTable(event, 'Group A')
    for (const name of ['Wins', 'Losses', 'Game difference', 'Games won']) {
      await expect(table.getByRole('columnheader', { name })).toBeVisible()
    }

    // The champion, named — `player.1`, not their entry id. Shown because the group is
    // complete and single (a decided pure round-robin has one).
    await expect(pom.standingsChampion(event)).toBeVisible()
    await expect(pom.standingsChampion(event)).toContainText('player.1')

    // Every request landed on a route this stub has, and nothing raised an error surface —
    // the results are just BFF data on the detail read, so drawing them fires no toast.
    expect(store.unhandled).toEqual([])
    await expect(pom.toasts).toHaveCount(0)
  })

  test('a viewer sees the standings too — results are public', async ({ page }) => {
    // A player wants to know how their group finished. Standings are read-only for
    // everyone, so a non-owner sees the same table (and never a control — the table
    // carries none).
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...STANDINGS_SEED,
      canEdit: false,
    })
    const event = EVENT.JOURNEY

    await expect(pom.standingsRowNames(event, 'Group A')).toHaveText([
      'player.1',
      'player.2',
    ])
    await expect(pom.standingsChampion(event)).toContainText('player.1')
  })

  test('an event with no results stands nothing', async ({ page }) => {
    // The drawable seed WITHOUT `standings`: JOURNEY has a draw but no result yet, so there
    // is nothing to stand — the panel is absent, a designed empty state, not an empty table.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      drawable: true,
      drawn: [EVENT.JOURNEY],
    })

    await expect(pom.drawPanel(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.standingsPanel(EVENT.JOURNEY)).toHaveCount(0)
  })
})
