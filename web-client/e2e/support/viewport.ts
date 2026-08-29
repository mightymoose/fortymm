import { expect, type Locator, type Page } from '@playwright/test'

/** How long to keep re-measuring an element that is not (yet) on screen before believing
 * it. Generous next to the sheet's 200ms entrance, and a cap rather than a sleep: a
 * layout that is genuinely broken fails after this, with the numbers. */
const SETTLE_TIMEOUT_MS = 2000

/** The rectangle a locator occupies, re-measured until it is inside `viewport` or the
 * clock runs out — and the LAST measurement either way, which is what the assertions
 * below then speak about.
 *
 * ⚠️ It has to retry, and it must not "wait for the animation" instead. The sheet slides
 * in from the right (`data-open:slide-in-from-right-10`), so for ~200ms after it opens
 * every element in it genuinely is off the right-hand edge: a single `boundingBox()` taken
 * the moment the sheet becomes *visible* reports a 24px lie and fails a layout that is
 * perfectly fine. The obvious fix — await `element.getAnimations()` — does not work here
 * and was measured not working: at that instant the CSS animation has not been REGISTERED
 * yet, so the list comes back empty and the helper sails straight on into the same bad
 * reading.
 *
 * Retrying is also the only version of this that cannot go green on a broken layout: a row
 * that renders past the edge and STAYS there is re-measured, still past the edge, until
 * the deadline — and then fails, holding the very coordinates that prove it. Nothing here
 * scrolls, ever (see the warning on `expectOnScreen`).
 */
async function settledBox(
  page: Page,
  locator: Locator,
  viewport: { width: number; height: number },
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const fits = (box: { x: number; y: number; width: number; height: number }) =>
    box.x >= 0 &&
    box.y >= 0 &&
    Math.round(box.x + box.width) <= viewport.width &&
    Math.round(box.y + box.height) <= viewport.height

  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  let box = await locator.boundingBox()
  while (Date.now() < deadline && box !== null && !fits(box)) {
    await page.waitForTimeout(50)
    box = await locator.boundingBox()
  }
  return box
}

/**
 * Assert an element is not merely *in the DOM*, and not merely *"visible"*, but
 * **on the screen** — every edge of it inside the viewport.
 *
 * The distinction is the bug (#783 QA, round three). The event editor's rule row was
 * `grid-cols-[160px_180px_1fr_auto]`, and at 375px that fixed 340px prefix pushed the
 * Value input to `x=381` — six pixels past the right-hand edge of the phone — taking
 * the Remove button and the rule's new red validation message with it. On a phone the
 * form therefore refused to save and showed the reason to **nobody**.
 *
 * Every assertion one would ordinarily reach for passes in that state:
 *
 * - `toBeInTheDocument()` — it is in the document.
 * - `toBeVisible()` — Playwright's definition is *"has a non-empty bounding box and no
 *   `visibility: hidden`"*. An element sitting 6px off the right edge of the world has
 *   a perfectly good bounding box.
 * - `toHaveText(...)` — the text is there. It is simply somewhere the user is not.
 *
 * So the assertion has to be about **coordinates**, and it is the only kind that could
 * have caught this.
 *
 * ⚠️ And it must NOT scroll first. The obvious `scrollIntoViewIfNeeded()` was in this
 * helper for one run, and it **hid the bug**: the editor's body is a scroll container,
 * `overflow-y: auto` computes `overflow-x: auto`, and so scrolling the Value input
 * "into view" simply scrolled the sheet sideways — the assertion then passed against
 * the very grid that shipped the defect. An element a user can only see by discovering
 * a horizontal scroll they have no reason to expect is not on screen. Measured where it
 * renders, therefore, and nowhere else.
 */
export async function expectOnScreen(
  page: Page,
  locator: Locator,
  what: string,
): Promise<void> {
  // Rendered at all — the weak claim, stated first so a genuinely missing element
  // fails with "not visible" rather than with confusing geometry. It is also exactly
  // the assertion that passed throughout the bug.
  await expect(locator, `${what} should be rendered`).toBeVisible()

  const viewport = page.viewportSize()
  expect(viewport, 'the test must set a viewport size').not.toBeNull()
  if (!viewport) return

  // Where it comes to REST — re-measured while the sheet is still sliding in, so the
  // number the assertions below speak about is the element's own and not the entrance
  // animation's (see `settledBox`). A broken layout never settles, and fails with the
  // coordinates that damn it.
  const box = await settledBox(page, locator, viewport)
  expect(box, `${what} should have a bounding box`).not.toBeNull()
  if (!box) return

  expect(
    box.x,
    `${what} starts ${Math.round(box.x)}px from the left — off the left edge`,
  ).toBeGreaterThanOrEqual(0)
  expect(
    Math.round(box.x + box.width),
    `${what} ends ${Math.round(box.x + box.width)}px from the left, past the ${viewport.width}px viewport`,
  ).toBeLessThanOrEqual(viewport.width)
  expect(box.y, `${what} is above the top of the viewport`).toBeGreaterThanOrEqual(0)
  expect(
    Math.round(box.y + box.height),
    `${what} runs past the bottom of the ${viewport.height}px viewport`,
  ).toBeLessThanOrEqual(viewport.height)

  // Playwright's own intersection check, at `ratio: 1` — the WHOLE element inside the
  // viewport, not a sliver of it. Belt and braces with the geometry above: this one is
  // auto-retrying, so it also rules out a transient mid-animation reading.
  await expect(locator, `${what} should be wholly in the viewport`).toBeInViewport({
    ratio: 1,
  })
}

/**
 * Assert `locator`'s own box stays inside the viewport's WIDTH only — never off the
 * left or right edge. The X-axis half of `expectOnScreen`, split out for a caller
 * whose element is allowed to sit below the fold: a grid that legitimately stacks
 * its items into multiple rows on a narrow viewport puts later items below the
 * viewport's bottom edge as ordinary vertical scrolling, not a bug, so
 * `expectOnScreen`'s Y-axis and `toBeInViewport({ ratio: 1 })` checks would fail
 * them for a reason unrelated to whatever this caller is proving
 * (`tournament-mobile-header.spec.ts`'s hero-stat-tile checks, #1536).
 *
 * Deliberately does not call `expectOnScreen` with a narrowed axis, and does not
 * settle/retry via `settledBox`: the callers of this helper measure a grid that has
 * already finished laying out (no slide-in entrance to wait through), so a single
 * `getBoundingClientRect()` is enough.
 */
export async function expectWithinViewportWidth(
  page: Page,
  locator: Locator,
  what: string,
): Promise<void> {
  const viewport = page.viewportSize()
  expect(viewport, 'the test must set a viewport size').not.toBeNull()
  if (!viewport) return
  const box = await locator.evaluate((el) => el.getBoundingClientRect())
  expect(
    box.x,
    `${what} starts ${Math.round(box.x)}px from the left — off the left edge`,
  ).toBeGreaterThanOrEqual(0)
  expect(
    Math.round(box.x + box.width),
    `${what} ends ${Math.round(box.x + box.width)}px from the left, past the ${viewport.width}px viewport`,
  ).toBeLessThanOrEqual(viewport.width)
}

/**
 * Assert a scroll container does not scroll **sideways** — the mechanism behind every
 * off-screen field this suite has now met twice (#783 QA, rounds three and four).
 *
 * `overflow-y: auto` computes `overflow-x: auto` as well. So a row too wide for a phone
 * does not clip, and does not visibly break: the container quietly grows a horizontal
 * scroll, the fields sail off to `x=467`, and everything still reports itself present
 * and `toBeVisible()`. Vertical scrolling is the design (a long form on a short screen
 * must scroll); horizontal scrolling in the same box is the defect — so this asserts the
 * one without forbidding the other.
 *
 * It complements `expectOnScreen` rather than replacing it: that one proves a *named*
 * control is where the user is, this one proves there is nowhere else for anything to
 * be.
 */
export async function expectNoHorizontalScroll(
  locator: Locator,
  what: string,
): Promise<void> {
  // No settling needed, and that is not an oversight: `scrollWidth`/`clientWidth` are
  // LAYOUT, and the sheet's entrance is a `transform`. A transform moves a box; it does
  // not widen its content.
  const size = await locator.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollLeft: el.scrollLeft,
  }))

  // 1px of slack for sub-pixel layout rounding — the bug this catches is ~100px wide.
  expect(
    size.scrollWidth,
    `${what} scrolls sideways: its content is ${size.scrollWidth}px wide inside a ${size.clientWidth}px box`,
  ).toBeLessThanOrEqual(size.clientWidth + 1)
  expect(size.scrollLeft, `${what} is already scrolled sideways`).toBe(0)
}

/**
 * Bring `target` into view inside `container` by scrolling it **vertically**, and by no
 * other means.
 *
 * A phone spec has to scroll to reach the foot of a long form — a form taller than the
 * screen is not a bug, it is a form — and it must not cheat while doing it.
 * `scrollIntoView()` / `scrollIntoViewIfNeeded()` are exactly that cheat: they scroll
 * along *both* axes, so they will happily drag the sheet sideways to "reveal" a field
 * that is off the right-hand edge, and the assertion that follows then passes against the
 * very layout that shipped the defect. That is not a hypothetical — it is what this
 * suite's first attempt at the rule row did (see the warning on `expectOnScreen`).
 *
 * So this only ever writes `scrollTop`. `scrollLeft` is untouched, which means a field
 * laid out past the right-hand edge STAYS past it, and `expectOnScreen` still catches it.
 */
export async function scrollVerticallyIntoView(
  container: Locator,
  target: Locator,
): Promise<void> {
  const handle = await target.elementHandle()
  await container.evaluate((box, element) => {
    if (!(element instanceof HTMLElement)) return
    const view = box.getBoundingClientRect()
    const item = element.getBoundingClientRect()
    // Centre it in the container — a field flush against the bottom edge is technically
    // "in view" and practically half under the footer's shadow.
    box.scrollTop += item.top - view.top - (view.height - item.height) / 2
  }, handle)
}
