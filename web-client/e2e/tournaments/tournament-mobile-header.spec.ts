/**
 * The tournament detail page's **header on a phone** (#1044).
 *
 * Quinn opened a tournament at 375x667 and the page scrolled sideways: 452px of
 * content in a 375px viewport. The lifecycle button hung off the right-hand edge,
 * and the title column was squeezed to about one character wide — "QUINN OPEN
 * 2026" laid out one letter per line, pushing every other thing on the page below
 * the fold.
 *
 * The mechanism, and why one root cause produced all three symptoms at once: the
 * action block is a hard-coded `w-[380px] max-w-full` (`lifecycle-actions.tsx`),
 * wider than the phone itself. The header used to be `flex items-start` with a
 * `shrink-0 pt-7` wrapper around it, so the wrapper took its whole 380px and the
 * `max-w-full` resolved against **that wrapper** rather than the page — capping
 * nothing. The title column shared the same row, so it collapsed to its min-content
 * width, which for a display font is roughly one glyph.
 *
 * PR #1062 fixed it in two lines, and only in two lines:
 *
 *     -    <div className="mb-8 flex items-start gap-6">
 *     +    <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-start">
 *     -      {action && <div className="shrink-0 pt-7">{action}</div>}
 *     +      {action && <div className="shrink-0 sm:pt-7">{action}</div>}
 *
 * Below the `sm` breakpoint the header is now a **column**, so `max-w-full`
 * resolves against the full content width and caps the action block. That is the
 * whole fix — and it rests entirely on a media query that nothing asserted. This
 * spec is what stops a revert of either line shipping in silence.
 *
 * **The claim cannot be made in vitest.** jsdom performs no layout, so
 * `scrollWidth` and `clientWidth` are `0` for every element there: an overflow
 * assertion written in vitest passes identically against the broken page, the fixed
 * page, and a page that renders nothing at all. `tournament-venue.spec.ts` states
 * the same thing about the venue line, and is the model for this file.
 *
 * ## Observed failing
 *
 * Reverting the two lines above and re-running reds **four of these six tests**,
 * each with a measured number and none by timeout. Observed at 375x667:
 *
 * | Test | Under the revert | With the fix |
 * | --- | --- | --- |
 * | does not scroll the page sideways | `html` 452px inside 375px | 375 / 375 |
 * | keeps the lifecycle button wholly on screen | ends 452px from the left | ends at 327 |
 * | does not collapse the title | `h1` **0px** wide, 576px tall | 279px wide, 36px tall |
 * | the long name wraps and does not scroll | `html` 452px inside 375px | 375 / 375 |
 *
 * That 452px is the number Quinn measured by hand, reproduced exactly.
 *
 * The other two stay green under the revert, correctly: the widest-label test is
 * about copy and not layout, and the instrument control plants its own 4000px probe,
 * so it must notice an overflow in either state — that is what makes it a control.
 *
 * Each claim is its own `test()` on purpose. `expectNoHorizontalScroll` and
 * `expectOnScreen` assert internally, so three claims in one test would report only
 * whichever fired first — and the falsification is the entire deliverable here.
 * Separate tests mean separately named reds, each holding the number that damns it.
 * It is also what makes the paragraph above sayable: run as one test, the button and
 * title symptoms would have been masked by the document-width failure.
 *
 * ## `w-[380px]` is still in the code
 *
 * Deliberately (Non-Goals, #1044). It no longer overflows, because `flex-col` below
 * 640px caps it — but between 640px and ~1024px it still claims 380px of the row.
 * This spec pins the phone, which is where the defect was reported and where the
 * fix lives. It does not bless the width.
 */
import { expect, test } from '@playwright/test'

import { UNBREAKABLE_TOURNAMENT_NAME } from '../../src/mocks/factories/tournaments/tournament.factory'
import {
  TournamentDetailPage,
  type LifecycleLabel,
} from '../page-objects/tournaments/tournament-detail.page'
import { expectNoHorizontalScroll, expectOnScreen } from '../support/viewport'
import type { TournamentsStoreOptions } from '../page-objects/tournaments/tournaments-store'

/** The repo's established phone viewport — `app-shell.spec.ts`,
 * `dashboard-tournament-panel.spec.ts`, `dashboard-recent-results.spec.ts`,
 * `matches/match-details.spec.ts` and `design-system.spec.ts` all use it, and it is
 * the width Quinn measured the overflow at.
 *
 * At the file's top level, so nothing here can silently run at the config's 1280px
 * desktop default and prove nothing. */
test.use({ viewport: { width: 375, height: 667 } })

/** The status whose lifecycle label is **widest** — the hardest case for a header
 * that has to fit a button beside a title, and the one the three symptom tests are
 * written against.
 *
 * It is `published` because the test below **measured** all three labels, not
 * because the ticket said so. Passed explicitly even though the store already
 * defaults to it: a spec whose difficulty depends on a default is a spec that gets
 * quietly easier the day the default moves.
 *
 * Bare, rather than `READY_TO_START`. The go-live precondition (ADR-0786) is only
 * checked when the button is *clicked*, and nothing here clicks: `LifecycleActions`
 * renders its refusal `Alert` from `move()`, so an unclicked button on a tournament
 * with no draws looks exactly like one on a tournament ready to start. Seeding the
 * draws would add a taller column and several fixtures to a layout claim that does
 * not rest on either. */
const WIDEST: TournamentsStoreOptions = { status: 'published' }
const WIDEST_LABEL: LifecycleLabel = 'Start tournament'

/** The status each lifecycle label is offered from (ADR-0017's edge table). */
const LABEL_FOR: ReadonlyArray<{
  status: NonNullable<TournamentsStoreOptions['status']>
  label: LifecycleLabel
}> = [
  { status: 'draft', label: 'Publish' },
  { status: 'published', label: 'Start tournament' },
  { status: 'live', label: 'End tournament' },
]

test.describe('the tournament detail header on a phone', () => {
  /**
   * Which label is widest, **measured**.
   *
   * The ticket carries a table saying "Start tournament" is the widest of the
   * three, and a spec that took its word for it would be pinning the header at
   * whatever difficulty the table happened to be right about. Worse, it would go on
   * passing after a label was renamed — testing the narrow case while claiming the
   * wide one.
   *
   * So this asserts the *relation* rather than the string: the label the three
   * tests below run against is wider than both others. Rename a label and this test
   * is what tells you the rest of the file is now aiming at the wrong status.
   */
  test(`"${WIDEST_LABEL}" is the widest lifecycle label`, async ({ page }) => {
    const widths: Record<string, number> = {}
    for (const { status, label } of LABEL_FOR) {
      const { pom } = await TournamentDetailPage.navigateTo(page, { status })
      const box = await pom.lifecycleButton(label).boundingBox()
      expect(box, `the "${label}" button should have a bounding box`).not.toBeNull()
      widths[label] = box ? box.width : 0
    }

    const measured = Object.entries(widths)
      .map(([label, width]) => `${label} ${Math.round(width)}px`)
      .join(', ')
    for (const { label } of LABEL_FOR) {
      if (label === WIDEST_LABEL) continue
      expect(
        widths[WIDEST_LABEL],
        `"${WIDEST_LABEL}" is not the widest lifecycle label — measured ${measured}`,
      ).toBeGreaterThan(widths[label])
    }
  })

  /**
   * THE CLAIM, first symptom: the page stays inside the phone.
   *
   * `html` is the scrolling element, so `scrollWidth > clientWidth` here is exactly
   * "the user can scroll the page sideways" — the thing Quinn saw, rather than a
   * proxy for it somewhere in the tree.
   */
  test('does not scroll the page sideways', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, WIDEST)

    await expectNoHorizontalScroll(pom.documentElement, 'the tournament detail page')
  })

  /**
   * Second symptom: the lifecycle button is somewhere the user can reach it.
   *
   * `toBeVisible()` passed throughout the bug and would pass again — Playwright
   * defines visible as a non-empty bounding box with no `visibility: hidden`, and a
   * button sitting at `x=381` in a 375px viewport has a perfectly good one. Only an
   * assertion about **coordinates** can catch this, which is what `expectOnScreen`
   * is (see its docstring, and #783 round three).
   */
  test('keeps the lifecycle button wholly on screen', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, WIDEST)

    await expectOnScreen(
      page,
      pom.lifecycleButton(WIDEST_LABEL),
      `the "${WIDEST_LABEL}" button`,
    )
  })

  /**
   * Third symptom, and the one that made the page unusable rather than merely
   * untidy: the title is not squeezed to one glyph.
   *
   * Measured with `evaluate` and **not** gated behind `toBeVisible()`, deliberately.
   * Under the bug the title column collapses towards zero width, and Playwright's
   * visibility check fails on a zero-area box — which would red this test with a
   * 5000ms timeout, the one red the ticket rules out because it cannot tell "the
   * layout is broken" from "the harness never got there".
   *
   * The harness-got-there guarantee comes from `navigateTo`, which already waits
   * for an event card to be on screen before returning.
   */
  test('does not collapse the title to a single column of letters', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, WIDEST)

    const title = await pom.title.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { width: box.width, height: box.height }
    })

    // Well clear of one glyph. `src/index.css` forces the display `h1` to 36px
    // below 1024px, so one uppercase character is roughly 20–36px wide — and under
    // the revert this box measured **0px wide and 576px tall**, the title laid out
    // one letter per line straight down the page. The page's content box is 279px
    // (a 375px viewport less the `px-12` padding), which is what the fixed title
    // measures.
    expect(
      title.width,
      `the title is only ${Math.round(title.width)}px wide — it has collapsed towards its min-content width`,
    ).toBeGreaterThan(200)

    // …and therefore ONE line tall, which is the symptom a width alone cannot
    // state: a title 279px wide and 800px tall would be a title still wrapping one
    // word per line. One line of this 36px display face is ~36px.
    expect(
      title.height,
      `the title is ${Math.round(title.height)}px tall — a one-line title is ~36px, so this is wrapping`,
    ).toBeLessThan(80)
  })

  /** The instrument's own control. Every assertion above is a comparison between
   * two measurements, and a measurement that had gone dead — the jsdom failure
   * mode, `0` for everything, and equally what a locator resolving to nothing would
   * give — satisfies the `<=`-shaped ones on a page with no fix in it at all. So:
   * plant something that genuinely does not fit, and check the same measurement
   * notices.
   *
   * The title assertions need no control of their own: they are lower bounds, and a
   * dead measurement returning `0` fails them rather than passing them. */
  test('the overflow measurement can see an overflow when there is one', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, WIDEST)

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

/**
 * A tournament name of 255 characters with **no break opportunity in it**.
 *
 * The three tests above use the seeded "Bay Area Open 2026", which fits on a phone
 * in three lines whatever the header does. A short fixture cannot show a title
 * collapse and cannot load `break-words` at all: a name with spaces in it wraps
 * whether that class is there or not. This case is the one that puts the wrap under
 * load — one unbroken word whose min-content width is its whole rendered width, so
 * an unwrapped title would be thousands of pixels wide.
 *
 * Height is deliberately NOT pinned here. Wrapping tall is the correct behaviour for
 * a 255-character title; the claim is that it wraps inside the phone rather than
 * running off the side of it.
 */
test.describe('a tournament name with no break opportunity in it', () => {
  test('wraps, and does not scroll the page sideways', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...WIDEST,
      longName: true,
    })

    // The whole name is on the page — this is a wrapping fix, not a hiding one.
    // The `h1` renders the title plus a trailing accent-dot `<span>`, so
    // `toContainText` rather than `toHaveText`.
    await expect(pom.title).toContainText(UNBREAKABLE_TOURNAMENT_NAME)

    // THE CLAIM: the page stays inside the viewport…
    await expectNoHorizontalScroll(pom.documentElement, 'the tournament detail page')
    // …and the two boxes the name lands in, named individually so a regression says
    // WHICH one came back rather than only that the page got wider. The crumb is
    // the interesting one: it carries `max-w-[360px] truncate`, a cap wider than
    // this phone's 279px content box, so it survives only by shrinking below it.
    await expectNoHorizontalScroll(pom.title, "the header's title")
    // The crumb is asserted with `expectOnScreen`, NOT `expectNoHorizontalScroll`,
    // and the difference is a real one rather than a preference. That helper asks
    // "does this box's content fit inside it", which is the right question for a box
    // that would grow a scrollbar (`overflow: auto`) — and the wrong one for this
    // crumb, which carries `truncate`, i.e. `overflow: hidden` + `nowrap`. Its
    // content is *meant* to exceed its box; that is what an ellipsis is. Measured
    // here: 2300px of name inside a 127px crumb, unscrollable (`scrollLeft` pinned
    // at 0 by `overflow: hidden`). Asserting the content fit would have demanded a
    // change to `page-heading.tsx`, which #1044 lists under Non-Goals.
    //
    // The claim that actually matters is the coordinate one: the crumb's `max-w-[360px]`
    // is wider than this phone's 279px content box, so it survives only by shrinking
    // below its own cap. It measures 127px — so it is not what widens the page.
    await expectOnScreen(page, pom.breadcrumbCurrent, "the breadcrumb's last crumb")

    // WRAPPED, not truncated and not clamped — the part `expectNoHorizontalScroll`
    // alone cannot distinguish, since `truncate` and `line-clamp` would both also
    // keep the page narrow while hiding the tournament's name.
    const title = await pom.title.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }))
    // Many lines tall. One line of this 36px display face is ~36px, so anything at
    // or near that is a 255-character name laid out on one line and cut off.
    expect(
      title.height,
      `the title is only ${Math.round(title.height)}px tall — it is not wrapping`,
    ).toBeGreaterThan(200)
    // Nothing MEANINGFUL hidden inside that box: a `line-clamp` drops whole lines,
    // so anything it hid would be at least one line tall.
    //
    // The bound is 12px rather than the venue spec's 1px, and the reason is in the
    // markup: this `h1` carries `leading-[0.92]`, a line box *smaller* than the
    // glyphs in it, so ascenders and descenders spill a few pixels past the
    // element's content box by design. Measured green here at 471 vs 468 — 3px,
    // which is that spill and not a clamp.
    //
    // 12 is chosen to sit in the gap between the two: comfortably above the spill,
    // and comfortably below ONE line box (36px × 0.92 ≈ 33px), so a `line-clamp` —
    // which drops whole lines — still reds. A 1px bound would red on the correct
    // layout; a 36px one would let a clamp hiding exactly one line through.
    const MAX_SPILL_PX = 12
    expect(
      title.scrollHeight - title.clientHeight,
      `${title.scrollHeight - title.clientHeight}px of the title is clipped out of view — that is a hidden line, not the leading-[0.92] spill`,
    ).toBeLessThan(MAX_SPILL_PX)
  })
})
