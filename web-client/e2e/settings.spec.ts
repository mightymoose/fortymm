/**
 * The settings page at a phone-sized viewport (#890).
 *
 * QA measured 394px of content in a 360px viewport on UAT: the page scrolled
 * sideways. The culprit is the page **header** — a no-wrap flex row holding a
 * 64px display `<h1>` ("SETTINGS", one unbreakable word, so its min-content
 * floor is its full rendered width) beside a username pill pinned at
 * `flex-shrink: 0`. Their sum plus the gap exceeds a 360px viewport's content
 * box. There was no mobile rule for the header at all.
 *
 * **The overflow scales with the username's length**, so a short-username test
 * PASSES AGAINST THE BUG — measured here: with a 3-char name the header fit and
 * the page did not scroll; with the 34-char name below the document measured
 * **579px in a 360px viewport**. The regression case therefore uses a genuinely
 * long (but schema-valid, ≤40 char) username, the way the real UAT account did.
 * After the fix both measure 360/360.
 *
 * jsdom has no layout, so vitest structurally cannot catch this. It has to be a
 * real browser measuring `document.documentElement.scrollWidth`.
 *
 * This suite runs with MSW OFF (see `playwright.config.ts` webServer env
 * `VITE_ENABLE_MSW: 'false'`), so the session is stubbed with `page.route` —
 * which is also how the long username gets injected.
 */
import { expect, test, type Page } from '@playwright/test'
import { sessionResponse } from '../src/test/factories'

/** The server's maximum: 40 chars, matching `^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$`.
 * This is the payload of the whole spec: with a short name the bug does not
 * reproduce at all, so a short-username test would sail straight past it. */
const LONG_USERNAME = 'bartholomew.montgomery-fitzwilliams-iii2'

/** iPhone-class narrow viewport — the width QA reported the overflow at. */
const NARROW = { width: 360, height: 740 }
const DESKTOP = { width: 1280, height: 900 }

async function withSession(page: Page, username: string) {
  const body = JSON.stringify(
    sessionResponse({
      user: {
        id: '3a6d18f2-91b4-4e07-bd25-6c8f04a2e913',
        username,
        email: 'player@example.com',
        confirmed_at: '2026-05-12T09:00:00Z',
      },
    }),
  )
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/v1/session')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      })
      return
    }
    // Everything else the shell happens to fetch (notification bell, etc.).
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    })
  })
  // The email section's CAPTCHA pulls a script from Cloudflare. Fulfil it with
  // a no-op so the suite never depends on the network — the widget then renders
  // its inline "couldn't load" state, which is narrow either way. (The real
  // Turnstile iframe is ~300px wide but lives inside a card with
  // `overflow: hidden`, so it is clipped, not propagated: it cannot widen the
  // document. That is exactly why the issue's blame on #sec-email was wrong.)
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  )
}

/** The horizontal-overflow measurement, as the browser sees it. */
async function measureWidths(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
}

async function gotoSettings(page: Page, username = LONG_USERNAME) {
  await withSession(page, username)
  await page.goto('/settings')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Settings' }),
  ).toBeVisible()
  // The pill renders from the same session payload; wait for it so we never
  // measure a header that is still one element short. (Scoped to the pill:
  // the app shell's own user name carries the same text, hidden on mobile.)
  await expect(page.getByTestId('settings-user-pill')).toContainText(username)
}

test.describe('Settings page — narrow viewport', () => {
  test('does not scroll horizontally at 360px with a long username', async ({
    page,
  }) => {
    await page.setViewportSize(NARROW)
    await gotoSettings(page)

    const { scrollWidth, clientWidth } = await measureWidths(page)
    expect(
      scrollWidth,
      `document is ${scrollWidth}px wide in a ${clientWidth}px viewport — the settings page scrolls sideways`,
    ).toBeLessThanOrEqual(clientWidth)
  })

  test('keeps the header inside the viewport at 360px with a long username', async ({
    page,
  }) => {
    await page.setViewportSize(NARROW)
    await gotoSettings(page)

    const heading = page.getByRole('heading', { level: 1, name: 'Settings' })
    const pill = page.getByTestId('settings-user-pill')

    for (const [name, box] of [
      ['heading', await heading.boundingBox()],
      ['username pill', await pill.boundingBox()],
    ] as const) {
      expect(box, `${name} should have a box`).not.toBeNull()
      expect(
        box!.x + box!.width,
        `${name} right edge overhangs the 360px viewport`,
      ).toBeLessThanOrEqual(NARROW.width)
    }
  })

  test('does not scroll horizontally at 360px with a short username', async ({
    page,
  }) => {
    // Measured: this case PASSED against the bug (the header happened to fit),
    // which is exactly the trap the long-username case above exists to avoid.
    // Kept as a plain guard — and as a marker that it proves nothing on its own.
    await page.setViewportSize(NARROW)
    await gotoSettings(page, 'ada')

    const { scrollWidth, clientWidth } = await measureWidths(page)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  })
})

test.describe('Settings page — desktop', () => {
  test('still renders the display heading beside the username pill', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP)
    await gotoSettings(page)

    const { scrollWidth, clientWidth } = await measureWidths(page)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)

    const heading = page.getByRole('heading', { level: 1, name: 'Settings' })
    const pill = page.getByTestId('settings-user-pill')
    const h = (await heading.boundingBox())!
    const p = (await pill.boundingBox())!

    // Same row: the pill sits to the right of the heading, vertically overlapping it.
    expect(p.x).toBeGreaterThan(h.x + h.width)
    expect(p.y).toBeLessThan(h.y + h.height)
    expect(h.y).toBeLessThan(p.y + p.height)

    // And the heading keeps its full 64px display size on desktop.
    const fontSize = await heading.evaluate(
      (el) => getComputedStyle(el).fontSize,
    )
    expect(fontSize).toBe('64px')
  })
})
