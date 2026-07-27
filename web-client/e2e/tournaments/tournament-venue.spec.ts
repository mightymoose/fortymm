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

import { UNBREAKABLE_VENUE_NAME } from '../../src/mocks/factories/tournaments/tournament.factory'
import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { expectNoHorizontalScroll } from '../support/viewport'

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

/**
 * A venue name of 680 characters with **no break opportunity in it** (#1199).
 *
 * The row exists: the server bounds address components at 255 on the way IN only,
 * so rows written before the bound — and anything reaching the API by a route other
 * than our form — still come back over the wire at any length, and
 * `TournamentDetailRead` says nothing about it (`maxLength` appears nowhere in the
 * generated `schema.d.ts`; `openapi-typescript` has no construct for it). The input
 * cap added alongside this stops the *next* one being created; it does nothing for
 * the ones already stored, which is why the wrap is the fix and the cap is not.
 *
 * **This claim can only be made here.** vitest runs in jsdom, which performs no
 * layout: `scrollWidth` and `clientWidth` are `0` for every element, so an overflow
 * assertion written there passes identically against the broken page, the fixed
 * page, and a page that renders nothing. A class-name assertion in vitest is a
 * statement about the markup; only the measurement below is a statement about what
 * the user gets.
 */
test.describe('a venue name with no break opportunity in it', () => {
  test('wraps, and does not scroll the page sideways', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      longVenue: true,
    })

    // The whole name is on the page — this is a wrapping fix, not a hiding one.
    // `toContainText`, because the line is the venue joined to its locality
    // (`fmtVenueLine`): the assertion is that all 680 characters survived, not
    // that they are the entire line.
    await expect(pom.venueText).toContainText(UNBREAKABLE_VENUE_NAME)

    // THE CLAIM: the page stays inside the viewport. Falsified by deleting the wrap
    // class and re-running: the venue span lays out 5236px wide and `html` reports
    // a 3146px scroll width inside a 1280px viewport.
    await expectNoHorizontalScroll(pom.documentElement, 'the tournament detail page')
    // …and the two boxes that produced it, named individually so a regression says
    // WHICH one came back rather than only that the page got wider.
    await expectNoHorizontalScroll(pom.venueText, "the header's venue name")
    await expectNoHorizontalScroll(
      pom.venueMapFallback,
      "the venue map's text fallback",
    )

    // WRAPPED, not truncated and not clamped — the part `expectNoHorizontalScroll`
    // alone cannot distinguish, since `truncate` and `line-clamp` would both also
    // keep the page narrow while hiding the organizer's venue.
    const text = await pom.venueText.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }))
    // Several lines tall. One line of this 14px meta strip is ~21px, so anything at
    // or below ~42px is a name laid out on one line and cut off.
    expect(
      text.height,
      `the venue name is only ${Math.round(text.height)}px tall — it is not wrapping`,
    ).toBeGreaterThan(60)
    // Nothing hidden inside that box: a `line-clamp` would leave the content taller
    // than the box it is shown in.
    expect(
      text.scrollHeight,
      `${text.scrollHeight - text.clientHeight}px of the venue name is clipped out of view`,
    ).toBeLessThanOrEqual(text.clientHeight + 1)

    // The map placeholder keeps its map-sized box and SCROLLS what will not fit —
    // and the label starts at the top of it. A centred flex item that overflows
    // spills past both edges, and nothing can scroll to the part above the top:
    // with plain `items-center` this box opened mid-word with ~60px of the venue
    // name permanently unreachable, which is a clamp by another name.
    const box = await pom.venueMapFallback.boundingBox()
    const labelBox = await pom.venueMapFallbackLabel.boundingBox()
    expect(box, 'the map fallback should have a bounding box').not.toBeNull()
    expect(labelBox, 'its label should have a bounding box').not.toBeNull()
    if (!box || !labelBox) return
    expect(
      Math.round(labelBox.y),
      'the venue label starts above the top of its own box, where nothing can scroll to it',
    ).toBeGreaterThanOrEqual(Math.round(box.y))
  })

  /** The instrument's own control. Every assertion above is "this number is not
   * bigger than that one", and a measurement that always came back `0` — the jsdom
   * failure mode, and equally what a locator resolving to a display:none element
   * would give — would satisfy all of them on a page with no fix in it at all. So:
   * plant something that genuinely does not fit, and check the same measurement
   * notices. */
  test('the overflow measurement can see an overflow when there is one', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      longVenue: true,
    })

    await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.cssText = 'width:4000px;height:1px'
      document.body.append(probe)
    })

    const size = await pom.documentElement.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }))
    expect(
      size.scrollWidth,
      'a 4000px element did not widen the document — the measurement is not live',
    ).toBeGreaterThan(size.clientWidth)
  })
})
