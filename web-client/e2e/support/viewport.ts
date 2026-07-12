import { expect, type Locator, type Page } from '@playwright/test'

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
  const box = await locator.boundingBox()
  expect(box, `${what} should have a bounding box`).not.toBeNull()
  if (!box || !viewport) return

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
