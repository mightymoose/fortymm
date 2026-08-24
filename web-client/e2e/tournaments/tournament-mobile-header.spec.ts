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
 * Reverting the two lines above and re-running reds **five of these tests**, each
 * with a measured number and none by timeout. Observed at 375x667:
 *
 * | Test | Under the revert | With the fix |
 * | --- | --- | --- |
 * | does not scroll the page sideways | `html` 452px inside 375px | 375 / 375 |
 * | keeps the lifecycle button wholly on screen | ends 452px from the left | ends at 327 |
 * | does not collapse the title | `h1` **0px** wide, 576px tall | 279px wide, 36px tall |
 * | the long name, does not scroll | `html` 452px inside 375px | 375 / 375 |
 * | the long name, wraps inside the header | `h1` content 19px inside a **0px** box | 279 / 279 |
 *
 * That 452px is the number Quinn measured by hand, reproduced exactly.
 *
 * Only two stay green under the revert, and both correctly: the widest-label test is
 * about copy and not layout, and the instrument control plants its own 4000px probe,
 * so it must notice an overflow in either state — that is what makes it a control.
 *
 * ## Two tests ship `test.fail()`
 *
 * The two `documentElement` tests above are **expected to fail**, and they do so on
 * CI only. The page really does scroll sideways at 375px on Linux, by 2px, and the
 * cause is the shared `TabsList` (`inline-flex w-fit`), which #1044 lists under
 * Non-Goals. #1361 carries it, measured.
 *
 * They are marked rather than deleted so the assertion keeps running, keeps its
 * number in the report, and reds with "Expected to fail, but passed" the day #1361
 * lands. Removing the marks is part of that fix, not of this one.
 *
 * The mark is conditional on the platform (`OVERFLOWS_HERE`), so a macOS run still
 * asserts the page fits and reds if it stops fitting. Only the platform that
 * actually overflows expects the failure.
 *
 * The marks cost this file no coverage of #1062. **Three** unmarked tests red under
 * the falsification — the lifecycle button, the title, and the long name's wrap —
 * and all three measure the header's own boxes rather than the document, so the tab
 * strip cannot reach them. (The other two unmarked tests stay green under the
 * revert by design, per the table above; they are a copy check and a control, and
 * they pin nothing about the header fix.)
 *
 * Measured on Linux against the production build: the two marked tests red at 377px
 * inside 375px, the stated reason and not a timeout, and the other five pass.
 *
 * The long name's wrap test is the one worth naming. It is unaffected by the tab
 * strip AND sensitive to the header revert, reddening at `h1` content 19px inside a
 * 0px box — so the strongest pin in the file is one of the tests that keeps running
 * unmarked on every platform.
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
import { expect, test, type Locator, type Page } from '@playwright/test'

import { UNBREAKABLE_TOURNAMENT_NAME } from '../../src/mocks/factories/tournaments/tournament.factory'
import {
  TournamentDetailPage,
  type LifecycleLabel,
} from '../page-objects/tournaments/tournament-detail.page'
import {
  expectNoHorizontalScroll,
  expectOnScreen,
  expectWithinViewportWidth,
} from '../support/viewport'
import type { TournamentsStoreOptions } from '../page-objects/tournaments/tournaments-store'

/**
 * `TournamentDetailPage.navigateTo`, plus a wait for the **webfonts to settle**.
 *
 * Every measurement in this file is the box around some text, and `src/index.css`
 * fetches Bebas Neue and Space Grotesk from `fonts.googleapis.com` with
 * `display=swap`. The store's `page.route` only covers the API, so those font
 * requests go to the real network and the first paint uses a fallback face with
 * different metrics — `navigateTo` waits for an event card, which says nothing
 * about type.
 *
 * The size of that difference, measured here at 375x667: the title is **36px** tall
 * in Bebas and **72px** in the fallback, against this file's `< 80` bound. Eight
 * pixels of headroom on a webfont fetched over the public internet is not a bound,
 * it is a race — and when it trips, the message blames wrapping for a font.
 *
 * `document.fonts.ready` settles on failure as well as on success, so this cannot
 * hang a run with no network; it makes the measurement deterministic rather than
 * making it depend on Google.
 */
async function navigate(page: Page, options: TournamentsStoreOptions) {
  const { pom } = await TournamentDetailPage.navigateTo(page, options)
  await page.evaluate(() => document.fonts.ready)
  return pom
}

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

/**
 * Whether the platform running this suite is one the #1361 tab-strip overflow
 * reproduces on. See the "Two tests ship `test.fail()`" note at the top of the file.
 *
 * The margin is about **0.13px**: the tab strip needs ~327px, the page's `px-12`
 * takes 96px, and 327.13 + 48 lands at 375.13 in a 375px viewport. Linux shapes the
 * same string about 2px wider than macOS does, which is the whole of the difference
 * between a page that fits and one that scrolls.
 *
 * Keyed on the platform rather than on `process.env.CI`, because the cause is text
 * shaping and not the runner. A developer on Linux sees the same 377px.
 */
const OVERFLOWS_HERE = process.platform === 'linux'

/** Why the two `documentElement` tests are expected to fail where they are. Shown
 * by Playwright's reporter beside the annotation. */
const TAB_STRIP_OVERFLOW =
  '#1361 — the shared TabsList is `inline-flex w-fit`, so the page measures 377px inside 375px on Linux'

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
      const pom = await navigate(page, { status })
      // `evaluate` rather than `boundingBox()`, so a missing button reds here with
      // a locator error instead of yielding a `null` that a fallback would have to
      // turn into a fabricated `0` — and a `0` on a NON-widest label is a number
      // this test's `toBeGreaterThan` would happily pass.
      widths[label] = await pom
        .lifecycleButton(label)
        .evaluate((el) => el.getBoundingClientRect().width)
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
    // EXPECTED TO FAIL — the page really does scroll sideways, by 2px, and #1361
    // holds the cause: the shared `TabsList` is `inline-flex w-fit`, so the tab
    // strip takes the ~327px its tabs need and ends at ~375.13px inside the page's
    // `px-12`. That 0.13px of margin survives on macOS and does not survive on
    // Linux, which shapes the same text about 2px wider. Local 375/375, CI 377/375.
    //
    // Marked rather than deleted, deliberately. `test.fail()` keeps the assertion
    // running and keeps its measured number in the report, and Playwright reds with
    // "Expected to fail, but passed" the moment #1361 lands — so the fix cannot
    // ship without someone coming back here. A deleted test would have gone quiet.
    //
    // This does NOT weaken the file's claim. #1044 exists to pin the header fix
    // from #1062, and three unmarked tests do that on their own — the button, the
    // title and the long name's wrap. All three measure the header's own boxes, not
    // the whole document, so the tab strip cannot reach them, and all three red
    // under the falsification. Under the falsification this test reds at 452px, the
    // number Quinn measured; the 377px here is a different and smaller defect that
    // #1044 lists under Non-Goals.
    //
    // Conditioned on the platform rather than marked outright, because the defect
    // IS conditioned on the platform: 375/375 on macOS, 377/375 on Linux. A bare
    // `test.fail()` would red every macOS run with "Expected to fail, but passed",
    // which is a false red on the machine where the page is genuinely fine.
    test.fail(OVERFLOWS_HERE, TAB_STRIP_OVERFLOW)

    const pom = await navigate(page, WIDEST)

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
    const pom = await navigate(page, WIDEST)

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
    const pom = await navigate(page, WIDEST)

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
    const pom = await navigate(page, WIDEST)

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
  /**
   * The document-width half of this case, split into its own test so the tab strip
   * cannot take the wrapping assertions down with it.
   *
   * EXPECTED TO FAIL, for the same reason and under the same issue as its sibling
   * above: #1361, the `inline-flex w-fit` `TabsList`, 377px inside 375px on Linux.
   * The split matters. Left in one test, `expectNoHorizontalScroll` asserts
   * internally and would have thrown before the wrap assertions ever ran, so
   * marking that one test `test.fail()` would have silently stopped pinning the
   * wrap as well — which is the part of this case that is about `break-words` and
   * has nothing to do with the tab strip.
   */
  test('does not scroll the page sideways', async ({ page }) => {
    test.fail(OVERFLOWS_HERE, TAB_STRIP_OVERFLOW)

    const pom = await navigate(page, { ...WIDEST, longName: true })

    await expectNoHorizontalScroll(pom.documentElement, 'the tournament detail page')
  })

  test('wraps inside the header rather than running off the side of it', async ({
    page,
  }) => {
    const pom = await navigate(page, { ...WIDEST, longName: true })

    // The whole name is on the page — this is a wrapping fix, not a hiding one.
    // The `h1` renders the title plus a trailing accent-dot `<span>`, so
    // `toContainText` rather than `toHaveText`.
    await expect(pom.title).toContainText(UNBREAKABLE_TOURNAMENT_NAME)

    // THE CLAIM: the boxes the name lands in stay inside the phone, named
    // individually so a regression says
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
    //
    // Pinned to the name FIRST, because `breadcrumbCurrent` is a positional locator
    // (`span`, `.last()`) and the same nav also holds the 8px `aria-hidden` accent
    // dot and the `/` separators. `expectOnScreen` on the dot passes — measured —
    // so without this line any change to the nav's DOM order would turn the
    // assertion below vacuously green rather than red.
    await expect(pom.breadcrumbCurrent).toContainText(UNBREAKABLE_TOURNAMENT_NAME)
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
    // The bound is 12px rather than the venue spec's 1px, and the reason is the
    // display face's own metrics: Bebas Neue's ascenders and descenders spill a few
    // pixels past a line box this tight, so `scrollHeight` sits a little above
    // `clientHeight` on a title that is wrapping perfectly. Measured green here at
    // 471 vs 468 — 3px — and that spill is CONSTANT rather than per-line: measured
    // 3px on the one-line default name and 3px again on this 13-line one.
    //
    // Note the line box is 36px, not the `leading-[0.92]` this `h1` asks for.
    // `src/index.css` declares an unlayered `.dark.fortymm-theme h1 { line-height: 1 }`,
    // and unlayered CSS outranks Tailwind's layered utilities — the same override
    // #1044 records for the font-size. So one line here is 36px.
    //
    // 12 is chosen to sit in the gap: comfortably above the 3px spill, and
    // comfortably below ONE 36px line box, so a `line-clamp` — which drops whole
    // lines — still reds. A 1px bound would red on the correct layout; a 36px one
    // would let a clamp hiding exactly one line through.
    const MAX_SPILL_PX = 12
    expect(
      title.scrollHeight - title.clientHeight,
      `${title.scrollHeight - title.clientHeight}px of the title is clipped out of view — that is a hidden line, not the display face's ~3px spill`,
    ).toBeLessThan(MAX_SPILL_PX)
  })
})

/**
 * The five **hero stat tiles** — Events, Entries, Tables, Reservations, Days — on a
 * phone and on a tablet (#1536).
 *
 * `tournament-detail-page.tsx` rendered the strip as a bare `grid-cols-5`, with no
 * responsive breakpoint. Tailwind's `grid-cols-N` compiles to
 * `grid-template-columns: repeat(N, minmax(0, 1fr))` — the track's own floor is `0`,
 * not the column's content — so below `xl` (1280px) the five tracks divide up
 * whatever width the row has, however small. `HeroStat`'s outer `Card` carries
 * `overflow-hidden`, and per the grid sizing algorithm an item's *automatic* minimum
 * size collapses to `0` (rather than its content's) once the item's own overflow is
 * anything but `visible` — so the `Card` willingly shrinks below what its icon chip,
 * padding and text need, instead of forcing the row to scroll. Everything past that
 * shrunk boundary — icon, number, label — is clipped by the same `overflow-hidden`.
 * The text is still real DOM content throughout: `toBeVisible()` and a screen reader
 * both find it. A sighted phone user finds an empty tile.
 *
 * The fix is the repo's established breakpoint ladder (`event-editor/basics-section.tsx`,
 * `events-tab/event-card.tsx`):
 *
 *     -  <div className="grid grid-cols-5 gap-3">
 *     +  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
 *
 * Below `xl` the row now LOSES a column at a time — each remaining tile gets more
 * room, not less — instead of shrinking every tile in place. The container caps at
 * `max-w-[1320px]`, and `xl` (1280px) already renders five across below that cap, so
 * no bespoke `min-[1320px]:` breakpoint is needed to hold the five-across row at
 * 1320px and up.
 *
 * **The claim cannot be made in vitest.** jsdom performs no layout (the same
 * constraint the file's own #1044 section above states), so every assertion below
 * measures a real box in a real browser.
 *
 * ## Observed failing
 *
 * Reverting the grid class to a bare `grid-cols-5` and re-running reds four of the
 * new tests — the ones comparing an actual width to its natural, unclipped
 * reference — with a measured number, none of them a timeout. Measured for the
 * first tile the loop reaches ("Events"; every other tile is clipped by at least
 * as much — "Reservations", the widest label, measures 44.8px actual against a
 * 91.8px natural width at 768px, the starkest of the five):
 *
 * | Test | 375px, under the revert | 375px, with the fix |
 * | --- | --- | --- |
 * | shows every tile's number at its full, unclipped width | "Events" value box **0px** wide (natural 47px) | 47px — matches natural |
 * | shows every tile's label at its full, unclipped width | "Events" label box **0px** wide (natural 47px) | 47px — matches natural |
 *
 * | Test | 768px, under the revert | 768px, with the fix |
 * | --- | --- | --- |
 * | shows every tile's number at its full, unclipped width | "Events" value box **44.8px** wide (natural 47.3px — clipped by 2.5px) | 47px — matches natural |
 * | shows every tile's label at its full, unclipped width | "Events" label box **44.8px** wide (natural 47.3px — clipped by 2.5px) | 47px — matches natural |
 *
 * The remaining new tests — the widest-label control, the "stays real text"
 * control, the one-line-height checks, and the on-screen-horizontally check —
 * stay GREEN under this revert, and correctly: none of the five labels here has
 * a break opportunity (each is one unbroken word), so this bug can never wrap one
 * onto a second line; `toContainText` reads DOM text regardless of layout; and
 * the grid track keeps every tile's own box inside the row's total width whether
 * the row is broken or not — the bug shrinks a tile's box, it does not push it off
 * the page. Only the value/label WIDTH comparisons are sensitive to this
 * particular failure, and both of them catch it, at both widths, with real
 * numbers.
 *
 * ## Why the value/label boxes, and not `toBeVisible()`
 *
 * Exactly the #1044 lesson above, repeated for a different bug: `toBeVisible()`
 * passed throughout, because Playwright's definition is a non-empty bounding box
 * with no `visibility: hidden` — and an element that has shrunk to (or near) `0×0`
 * still satisfies that the instant its content is empty of visible pixels but its
 * *box* technically has some. The claim here is narrower and stronger: the VALUE
 * and LABEL boxes each measure a real, positive width, and the label's box is short
 * enough that it can only be holding one line. Gated behind `toBeVisible()` this
 * would report a 5000ms timeout under the bug rather than the coordinates that
 * damn it — `expectOnScreen`'s own docstring above states why, and the reasoning is
 * identical here. The tile's own outer box (never clipped by the bug — it shrinks
 * to fit its grid track exactly, it does not vanish) is checked against the
 * viewport's WIDTH only, by `expectWithinViewportWidth` (imported from
 * `../support/viewport`, alongside `expectOnScreen`), and deliberately NOT with
 * `expectOnScreen`: below `sm` the fix stacks the five tiles one per row,
 * so a later tile legitimately sits below the fold on a 375x667 phone, and
 * `expectOnScreen`'s vertical + intersection checks would fail it for a reason
 * that has nothing to do with #1536.
 */

/** The tournament this section seeds: the default entry-shaped tournament plus
 * `crowded: true`, which adds a fourth event with twelve more entrants. Picked for
 * two edge cases the ticket calls out by name rather than for convenience:
 *
 * - **Entries goes multi-digit** (2 default + 12 crowd = 14) — the easy case is a
 *   lone digit, and a tile sized for "4" is not proof a tile sized for "14" fits.
 * - **Days renders its suffix** — the seed's events all default to the same
 *   `slot.date`, so the range is one day and the tile prints "1" beside a "day"
 *   suffix span, exercising the two-node value box (`{value}` + `<span>{suffix}</span>`)
 *   every other tile skips.
 *
 * `crowded` does not touch the Tables or Reservations counts (the crowd event
 * explicitly seeds no reservations of its own), so all five tiles carry a different,
 * genuinely-seeded number rather than four tiles quietly sharing one small default.
 */
const HERO_STATS_FIXTURE: TournamentsStoreOptions = { crowded: true }

/** The five tiles, their testid slug (`hero-stat.tsx`'s `slugify`), and the number
 * each renders under `HERO_STATS_FIXTURE` — spelled out here rather than derived,
 * so a change to the seed that quietly moved one of these numbers is a mismatch
 * this file catches at the `toContainText` checks below, not a silent drift. */
const HERO_STATS: ReadonlyArray<{ slug: string; label: string; value: string }> = [
  { slug: 'events', label: 'Events', value: '4' },
  { slug: 'entries', label: 'Entries', value: '14' },
  { slug: 'tables', label: 'Tables', value: '4' },
  { slug: 'reservations', label: 'Reservations', value: '1' },
  { slug: 'days', label: 'Days', value: '1' },
]

/** A viewport comfortably past `xl` (1280px) — five full columns, ~227px each per
 * the ticket's own arithmetic, so every tile has far more room than any value or
 * label needs. Used ONLY as a measurement reference (`naturalHeroStats` resizes
 * here, measures, and resizes straight back) — never the viewport a test actually
 * asserts geometry AT. */
const UNCLIPPED_VIEWPORT = { width: 1400, height: 900 }

/** Sub-pixel rounding slack between two measurements of the SAME text at two
 * viewport widths — not a tolerance for "a little bit of clipping is fine". Font
 * rendering depends on the glyphs and the font, not on an unrelated ancestor's
 * width, so an unclipped box measures the same figure at 375px, at 768px and at
 * `UNCLIPPED_VIEWPORT` give or take layout rounding. */
const CLIP_TOLERANCE_PX = 2

interface HeroStatBox {
  width: number
  height: number
}
type HeroStatBoxes = Record<string, { value: HeroStatBox; label: HeroStatBox }>

/** The width/height of one locator's box — the one measurement `measureHeroStats`
 * takes twice per tile (value, then label), factored so the two calls can't drift
 * out of step with each other. */
async function measureBox(locator: Locator): Promise<HeroStatBox> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
}

/** Every tile's value/label box, measured at the page's CURRENT viewport. */
async function measureHeroStats(pom: TournamentDetailPage): Promise<HeroStatBoxes> {
  const boxes: HeroStatBoxes = {}
  for (const { slug } of HERO_STATS) {
    boxes[slug] = {
      value: await measureBox(pom.heroStatValue(slug)),
      label: await measureBox(pom.heroStatLabel(slug)),
    }
  }
  return boxes
}

/**
 * Every tile's value/label box, measured at `UNCLIPPED_VIEWPORT` — the reference
 * size a correctly-laid-out tile owes its text at ANY width, per AC #5 and #6.
 * Resizes the page, measures, and restores the caller's own viewport, so it can
 * be called mid-test without disturbing what that test asserts geometry at.
 *
 * A reference measurement rather than a hard-coded pixel figure is deliberate,
 * and not merely tidier: it is the only design that catches BOTH of #1536's
 * failure shapes, which turned out to be two different mechanisms and not one.
 * At 375px the bug drives a tile's text box to a genuine 0×0 — a bare `> 0`
 * check would have caught that alone. At 768px there is just enough flex
 * remainder left over for the box to report a small but strictly POSITIVE
 * width (measured 44.8px for the "Reservations" label, which needs ~95px+) —
 * the box itself is not empty, the *text inside it* overflows and is cropped by
 * the tile's `overflow-hidden`, invisible to any bound stated as a bare
 * lower-bound constant. Comparing against how much room the label actually
 * needs is what catches both.
 */
async function naturalHeroStats(
  page: Page,
  pom: TournamentDetailPage,
): Promise<HeroStatBoxes> {
  const original = page.viewportSize()
  await page.setViewportSize(UNCLIPPED_VIEWPORT)
  const boxes = await measureHeroStats(pom)
  if (original) await page.setViewportSize(original)
  return boxes
}

test.describe('the hero stat tiles on a phone', () => {
  /**
   * Which label is widest, **measured** — the same discipline as
   * `"${WIDEST_LABEL}" is the widest lifecycle label` above, and for the same
   * reason: a test that took the ticket's ~105px estimate on faith would still
   * pass after "Reservations" was renamed to something narrower, testing the easy
   * case while claiming the hard one.
   *
   * Measured at `UNCLIPPED_VIEWPORT`, not at this file's 375px, so the answer
   * does not depend on which breakpoint happens to be live in the viewport this
   * test runs at.
   */
  test('"Reservations" is the widest hero stat label', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const measured = HERO_STATS.map(
      ({ label, slug }) => `${label} ${Math.round(natural[slug].label.width)}px`,
    ).join(', ')
    for (const { slug, label } of HERO_STATS) {
      if (label === 'Reservations') continue
      expect(
        natural.reservations.label.width,
        `"Reservations" is not the widest hero stat label — measured ${measured}`,
      ).toBeGreaterThan(natural[slug].label.width)
    }
  })

  /**
   * AC #6: a viewport at or above 1320px keeps the five-across row. Nothing else
   * in this section checks ROW STRUCTURE — every width/height comparison above
   * would stay green even if the row had silently dropped to four columns (a
   * typo'd `xl:grid-cols-4`, say): a four-across tile is WIDER, not narrower, so
   * every text box would still measure at least its natural width, and nothing
   * above would notice the fifth tile had wrapped onto a second row. This is the
   * test that would catch that.
   *
   * Measured at `UNCLIPPED_VIEWPORT` (1400px) rather than at exactly 1320px:
   * the container caps at `max-w-[1320px]` (`tournament-detail-page.tsx`), so the
   * row's own layout is identical from 1320px up — nothing between 1320px and
   * 1400px can change which breakpoint is live or how many columns render.
   */
  test('keeps all five tiles on one row at 1320px and up', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const original = page.viewportSize()
    await page.setViewportSize(UNCLIPPED_VIEWPORT)
    const tops: Record<string, number> = {}
    for (const { slug, label } of HERO_STATS) {
      tops[label] = await pom
        .heroStatTile(slug)
        .evaluate((el) => el.getBoundingClientRect().top)
    }
    if (original) await page.setViewportSize(original)
    const rows = new Set(Object.values(tops).map((top) => Math.round(top)))
    const measured = Object.entries(tops)
      .map(([label, top]) => `${label} y=${Math.round(top)}`)
      .join(', ')
    expect(rows.size, `the five tiles are not on one row — measured ${measured}`).toBe(1)
  })

  /** Every tile's number stays real DOM text throughout, whatever the layout does
   * with it — a control, not a layout claim: `toContainText` reads `textContent`
   * and does not require the element to be on screen, so this stays green under
   * the bug as well as the fix, and is what rules out "the fix hid the clipping by
   * deleting the text" as a way to pass the geometry assertions below. */
  test('keeps every tile\'s number and label as real text', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    for (const { slug, label, value } of HERO_STATS) {
      await expect(
        pom.heroStatValue(slug),
        `the "${label}" tile's value`,
      ).toContainText(value)
      await expect(
        pom.heroStatLabel(slug),
        `the "${label}" tile's label`,
      ).toHaveText(label)
    }
  })

  /** THE CLAIM, first half: every tile's number renders at its full,
   * unclipped width — compared against `naturalHeroStats`, not against a bare
   * lower bound (see that function's docstring for why: a bare bound cannot
   * distinguish a genuinely 0px value box from one that reports a small,
   * strictly positive width while most of its text is cropped by the tile's
   * `overflow-hidden`). Measured with `evaluate`, not `expectOnScreen` — the
   * value box shrinks under the bug rather than moving off screen, so a
   * visibility-gated assertion would time out instead of reporting the widths
   * that damn it (see the section docstring above). */
  test('shows every tile\'s number at its full, unclipped width', async ({
    page,
  }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].value.width,
        `the "${label}" tile's number is only ${Math.round(actual[slug].value.width)}px wide, short of its natural ${Math.round(natural[slug].value.width)}px — it is being clipped`,
      ).toBeGreaterThanOrEqual(natural[slug].value.width - CLIP_TOLERANCE_PX)
    }
  })

  /** Second half of the claim: every tile's label, likewise. */
  test('shows every tile\'s label at its full, unclipped width', async ({
    page,
  }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].label.width,
        `the "${label}" tile's label is only ${Math.round(actual[slug].label.width)}px wide, short of its natural ${Math.round(natural[slug].label.width)}px — it is being clipped`,
      ).toBeGreaterThanOrEqual(natural[slug].label.width - CLIP_TOLERANCE_PX)
    }
  })

  /** THE CLAIM's other axis: a label a width assertion alone cannot state. A label
   * box could satisfy the width bound above and still be wrapping — narrow AND
   * tall, two words stacked — which is not "on one line" even though it is not
   * "clipped to nothing" either. Compared against the natural, one-line height
   * for the same reason the width checks are: a fixed pixel bound would drift
   * with a copy or font change, where the reference measurement does not. */
  test('wraps no tile\'s label onto a second line', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].label.height,
        `the "${label}" tile's label is ${Math.round(actual[slug].label.height)}px tall against a one-line ${Math.round(natural[slug].label.height)}px — it is wrapping onto a second line`,
      ).toBeLessThanOrEqual(natural[slug].label.height + CLIP_TOLERANCE_PX)
    }
  })

  /** And the value line's own one-line claim — "Days" is the one tile whose value
   * carries a second DOM node (the suffix span), so this is the test that would
   * catch a suffix forcing its own line. */
  test('wraps no tile\'s number onto a second line', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].value.height,
        `the "${label}" tile's number is ${Math.round(actual[slug].value.height)}px tall against a one-line ${Math.round(natural[slug].value.height)}px — it is wrapping onto a second line`,
      ).toBeLessThanOrEqual(natural[slug].value.height + CLIP_TOLERANCE_PX)
    }
  })

  /** THE OTHER CLAIM the ticket makes: every tile's own box — not merely its text —
   * sits inside the phone's WIDTH, never off the left or right edge — the
   * #1044-shaped failure mode this ticket's fix does not introduce but which
   * nothing else here would notice. `expectWithinViewportWidth`, not
   * `expectOnScreen`: below `sm` the fix stacks the tiles one per row, so a later
   * tile legitimately sits below the fold on a 375x667 phone, which is normal
   * vertical scrolling and not a claim this section makes. */
  test('keeps every tile\'s own box within the viewport horizontally', async ({
    page,
  }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    for (const { slug, label } of HERO_STATS) {
      await expectWithinViewportWidth(page, pom.heroStatTile(slug), `the "${label}" tile`)
    }
  })
})

/**
 * The same claims, at a **768px-wide tablet** — the file's `md`/3-column step,
 * which the ticket's own arithmetic names as the tightest margin in the ladder
 * (tile ~216px, versus a widest-label minimum the tests above measure directly).
 *
 * Its own `test.use`, deliberately: the file sets its viewport at the top level, so
 * without an explicit override here this describe block would silently inherit
 * 375px and every assertion in it would prove nothing about 768px at all.
 */
test.describe('the hero stat tiles on a tablet', () => {
  test.use({ viewport: { width: 768, height: 1024 } })

  test('keeps every tile\'s number and label as real text', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    for (const { slug, label, value } of HERO_STATS) {
      await expect(
        pom.heroStatValue(slug),
        `the "${label}" tile's value`,
      ).toContainText(value)
      await expect(
        pom.heroStatLabel(slug),
        `the "${label}" tile's label`,
      ).toHaveText(label)
    }
  })

  test('shows every tile\'s number at its full, unclipped width', async ({
    page,
  }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].value.width,
        `the "${label}" tile's number is only ${Math.round(actual[slug].value.width)}px wide, short of its natural ${Math.round(natural[slug].value.width)}px — it is being clipped`,
      ).toBeGreaterThanOrEqual(natural[slug].value.width - CLIP_TOLERANCE_PX)
    }
  })

  test('shows every tile\'s label at its full, unclipped width', async ({
    page,
  }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].label.width,
        `the "${label}" tile's label is only ${Math.round(actual[slug].label.width)}px wide, short of its natural ${Math.round(natural[slug].label.width)}px — it is being clipped`,
      ).toBeGreaterThanOrEqual(natural[slug].label.width - CLIP_TOLERANCE_PX)
    }
  })

  test('wraps no tile\'s label onto a second line', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].label.height,
        `the "${label}" tile's label is ${Math.round(actual[slug].label.height)}px tall against a one-line ${Math.round(natural[slug].label.height)}px — it is wrapping onto a second line`,
      ).toBeLessThanOrEqual(natural[slug].label.height + CLIP_TOLERANCE_PX)
    }
  })

  test('wraps no tile\'s number onto a second line', async ({ page }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    const natural = await naturalHeroStats(page, pom)
    const actual = await measureHeroStats(pom)
    for (const { slug, label } of HERO_STATS) {
      expect(
        actual[slug].value.height,
        `the "${label}" tile's number is ${Math.round(actual[slug].value.height)}px tall against a one-line ${Math.round(natural[slug].value.height)}px — it is wrapping onto a second line`,
      ).toBeLessThanOrEqual(natural[slug].value.height + CLIP_TOLERANCE_PX)
    }
  })

  /** Same claim, and same reason for `expectWithinViewportWidth` over
   * `expectOnScreen`, as the phone block above: the `md` step renders three
   * columns, so the strip wraps to two rows, and the second row's tiles are
   * allowed to sit below the fold. */
  test('keeps every tile\'s own box within the viewport horizontally', async ({
    page,
  }) => {
    const pom = await navigate(page, HERO_STATS_FIXTURE)
    for (const { slug, label } of HERO_STATS) {
      await expectWithinViewportWidth(page, pom.heroStatTile(slug), `the "${label}" tile`)
    }
  })
})
