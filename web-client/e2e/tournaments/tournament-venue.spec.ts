/**
 * The venue on the tournament detail page — and, above all, the absence of one.
 *
 * A tournament may have **no venue at all**, at every status from draft to archived
 * (CONTEXT.md, "Venue"). It is a first-class state, not missing data, and it covers
 * two situations that behave identically: the room is not booked yet, and the venue
 * is deliberately withheld — a small tournament at somebody's home, whose address
 * must not be pinned on a public map.
 *
 * The rule this spec exists for: **a tournament with no venue renders NOTHING.** No
 * venue line, no pin, no map, and never a "Venue TBD" placeholder — that copy
 * promises a venue is coming (false when it is withheld) and implies a private
 * address is merely missing.
 *
 * Why a browser, when vitest already covers the component: `address` became nullable
 * on the wire (`TournamentDetailRead`), and this suite runs with **MSW off**, so it
 * is the only place a `null` address goes through the real `openapi-fetch` decode,
 * the real query cache and the real render. A page that threw on `address.latitude`
 * would still be green in vitest if a mock had quietly coalesced the null away.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'

test.describe('a tournament with no venue', () => {
  test('shows no venue line, no map, and no placeholder', async ({ page }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      venueless: true,
    })

    await expect(pom.venueLine).toHaveCount(0)
    await expect(pom.venueMap).toHaveCount(0)
    // The page rendered — the header is there, the events are there — so the two
    // absences above are a missing venue and not a crashed page.
    await expect(pom.statusBadge).toBeVisible()
    await expect(page.locator('body')).not.toContainText('TBD')
    // Nothing fell through the stub while the page fetched a null-address payload.
    expect(store.unhandled).toEqual([])
  })

  /** The positive control. Without it, both assertions above would pass against a
   * detail page that had stopped rendering venues altogether. */
  test('…while a tournament WITH a venue still shows both', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await expect(pom.venueLine).toContainText('Berkeley TT Club')
    // Keyless (this suite, dev and CI), `LocationMap` renders its text fallback —
    // labelled with the venue line — rather than loading Google.
    await expect(pom.venueMap).toHaveCount(1)
  })
})
