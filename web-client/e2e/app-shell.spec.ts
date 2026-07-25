/**
 * Regression guard for GitHub issue #887: the mobile navigation drawer was
 * closed with a CSS transform alone (`translateX(-100%)`), and **offscreen is
 * not hidden**. At 375px with the drawer visually shut, 48 controls — "Close
 * navigation" and every nav link — stayed focusable, tabbable and exposed to
 * assistive tech. A keyboard or screen-reader user could walk straight into a
 * menu that was not there.
 *
 * These assertions can only live here. jsdom has no layout: it cannot see a
 * transform, `visibility`, or a media query, so a vitest test would pass against
 * the broken code. The proof is a real browser telling us whether it will hand
 * focus to an element.
 *
 * The counterpart risk is the fix over-reaching: above 960px the *same*
 * `<aside>` is the permanent desktop sidebar, so the last describe below pins
 * that it is still fully navigable.
 *
 * The suite runs with MSW OFF (`playwright.config.ts` webServer env
 * `VITE_ENABLE_MSW: 'false'`), so the API is stubbed via `page.route`.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import type { components } from '../src/api/schema'
import { INTERACTIVE_SELECTOR } from '../src/test/read-only'
import {
  notificationFeed,
  notificationPreferences,
  notificationTaxonomy,
  sessionResponse,
} from '../src/test/factories'
import { fulfillParkedStream, STREAM_PATH } from './support/realtime'

const SESSION = sessionResponse({ user: { username: 'rita.kovac' } })

/** An empty inbox: the notifications page renders its designed empty state and
 * no row auto-marks itself read, so the page settles without further writes. */
const NOTIFICATION_FEED = notificationFeed({ items: [], unread_count: 0 })
const UNREAD_COUNT = {
  unread_count: 0,
} satisfies components['schemas']['UnreadCountResponse']
const PREFERENCES = notificationPreferences()
const TAXONOMY = notificationTaxonomy()

// `satisfies` (not `:`) so tsc fails if the OpenAPI schema drifts away from this
// stub — the e2e suite is MSW-off, so nothing else would catch it.
const DASHBOARD = {
  attention: [],
  attention_total_count: 0,
  waiting_count: 0,
  rating: null,
  completed_match_count: 0,
  recent_results: [],
  // No live tournament, so the dashboard's tournament panel never renders in
  // these specs — they are about the shell and the cards beneath it.
  tournaments: [],
} satisfies components['schemas']['DashboardResponse']

/** The page-load reads of every route this spec visits, keyed by path. */
const STUBS: Record<string, unknown> = {
  '/v1/session': SESSION,
  '/v1/dashboard': DASHBOARD,
  '/v1/notifications': NOTIFICATION_FEED,
  '/v1/notifications/unread-count': UNREAD_COUNT,
  '/v1/notification-preferences': PREFERENCES,
  '/v1/notification-taxonomy': TAXONOMY,
}

async function installMocks(page: Page) {
  await page.route('**/api/v1/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    // The realtime stream is not JSON, so it cannot fall through to the `[]`
    // below — see `./support/realtime`.
    if (path === STREAM_PATH) return fulfillParkedStream(route)
    const stub = STUBS[path]
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Anything else the AppShell happens to fetch on load.
      body: JSON.stringify(stub ?? []),
    })
  })
}

/** Everything a Tab press can land on.
 *
 * The one selector, imported — not a copy. `read-only.ts` exists because this
 * string forked three ways the first time it was pasted around, and a fork
 * written here would already have been the weaker one: it would have missed
 * `[role="switch"]` and `[role="radio"]`, so a toggle added to the sidebar
 * tomorrow would sail straight through this #887 guard. No disabled-filtering is
 * needed on top — the probe below asks the browser to focus each node and keeps
 * only what it actually lands on, which discards anything unfocusable anyway. */
const FOCUSABLE = INTERACTIVE_SELECTOR

/**
 * How many of the drawer's controls the browser will *actually* focus.
 *
 * Asking the browser to focus each one and seeing where `activeElement` lands is
 * the only mechanism-agnostic probe: it comes out right whether the drawer is
 * hidden with `visibility`, `display`, `inert`, `hidden`, or nothing at all. A
 * test that asserted on the CSS declaration instead would be re-typing the
 * implementation rather than checking the behaviour a keyboard user gets.
 */
async function focusableDrawerControls(page: Page) {
  return page.evaluate((sel) => {
    const drawer = document.getElementById('app-shell-sidebar')
    if (!drawer) throw new Error('#app-shell-sidebar is not in the document')
    const controls = Array.from(drawer.querySelectorAll<HTMLElement>(sel))
    const focusable: string[] = []
    for (const el of controls) {
      el.focus()
      if (document.activeElement === el) {
        focusable.push((el.textContent || el.getAttribute('aria-label') || el.tagName).trim())
        el.blur()
      }
    }
    // `total` guards every "focusable is 0" assertion against passing vacuously
    // — an empty drawer would also report zero focusable controls.
    return { total: controls.length, focusable }
  }, FOCUSABLE)
}

/**
 * The #887 metric itself, over the whole document: controls parked outside the
 * viewport that a Tab press would still reach. This read 48 before the fix.
 */
async function offscreenTabbableCount(page: Page) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
      const r = el.getBoundingClientRect()
      if (r.right >= 0 && r.left <= window.innerWidth) return false
      el.focus()
      const reachable = document.activeElement === el
      el.blur()
      return reachable
    }).length
  }, FOCUSABLE)
}

async function gotoWithSidebar(page: Page, path: string) {
  await installMocks(page)
  await page.goto(path)
  // The nav is permission-gated, so it only fills in once /v1/session resolves.
  // Wait on a link that is always present (matched with `includeHidden`, since
  // when the drawer is shut the whole point is that it is *not* exposed).
  await page
    .locator('#app-shell-sidebar')
    .getByRole('link', { name: 'Dashboard', includeHidden: true })
    .waitFor({ state: 'attached' })
}

async function gotoDashboard(page: Page) {
  await gotoWithSidebar(page, '/dashboard')
}

test.describe('Mobile navigation drawer (#887)', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('a closed drawer offers no focusable control and nothing offscreen is tabbable', async ({
    page,
  }) => {
    await gotoDashboard(page)

    const { total, focusable } = await focusableDrawerControls(page)

    // Not vacuous: the drawer really does hold controls — they just aren't
    // reachable.
    expect(total, 'controls present in the closed drawer').toBeGreaterThan(3)
    expect(focusable, 'focusable controls inside the closed drawer').toEqual([])

    // The issue's own measurement: this was 48.
    expect(
      await offscreenTabbableCount(page),
      'offscreen-but-tabbable controls on the page',
    ).toBe(0)
  })

  test('a closed drawer is not exposed to assistive tech', async ({ page }) => {
    await gotoDashboard(page)

    // `getByRole` matches only what ARIA considers non-hidden, so a zero count
    // here IS "absent from the accessibility tree".
    const drawer = page.locator('#app-shell-sidebar')
    await expect(drawer).toBeHidden()
    await expect(drawer.getByRole('link', { name: 'Matches' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  test('the hamburger aria-controls resolves to the drawer', async ({ page }) => {
    await gotoDashboard(page)

    // It declared `aria-controls="app-shell-sidebar"` while no element carried
    // that id — a dangling reference (#887).
    const target = await page
      .getByRole('button', { name: 'Open navigation' })
      .getAttribute('aria-controls')
    expect(target).toBe('app-shell-sidebar')
    await expect(page.locator(`#${target}`)).toHaveCount(1)
  })

  test('opening the drawer restores every control, and closing it takes them away again', async ({
    page,
  }) => {
    await gotoDashboard(page)

    await page.getByRole('button', { name: 'Open navigation' }).click()

    const drawer = page.locator('#app-shell-sidebar')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('link', { name: 'Matches' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    // Everything in the open drawer is reachable — including the close button,
    // which is the control a keyboard user needs to get back out.
    const open = await focusableDrawerControls(page)
    expect(open.focusable.length, 'focusable controls in the open drawer').toBe(open.total)
    expect(open.focusable).toContain('Close navigation')
    await drawer.getByRole('link', { name: 'Matches' }).focus()
    await expect(drawer.getByRole('link', { name: 'Matches' })).toBeFocused()

    // Shut it again: `visibility` is transitioned, so the controls go away when
    // the slide-out lands, not on the click. Poll rather than sample once.
    await page.getByRole('button', { name: 'Close navigation' }).click()
    await expect(drawer).toBeHidden()
    await expect
      .poll(
        async () => (await focusableDrawerControls(page)).focusable.length,
        { message: 'focusable controls after re-closing the drawer' },
      )
      .toBe(0)
    expect(await offscreenTabbableCount(page)).toBe(0)
  })
})

/**
 * #930: on `/notifications/settings` the sidebar told a screen reader it was on
 * three pages at once — Notifications, Inbox *and* Preferences — because
 * TanStack's `<Link>` marks every prefix match active. The eye saw one item lit
 * the whole time; only the accessibility layer lied, and it said you were in the
 * inbox while you were reading the preferences page.
 *
 * Both halves are asserted on every route. `aria-current` is read straight out
 * of the rendered DOM, and "still lit" is read as a **computed colour** rather
 * than a class name — a real browser is the only place that can tell us the
 * section highlight survived the a11y fix, which is the thing that must NOT
 * change. (The class-level version of this lives in the vitest suite.)
 */
test.describe('Exactly one current page (#930)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  const SIDEBAR = '#app-shell-sidebar'

  /** `label=value` for every sidebar link exposing itself as current. Reading
   * the *value* (not just counting) is deliberate: `aria-current="true"` on a
   * section ancestor would be wrong too — an ancestor announces nothing. */
  async function currentPageLinks(page: Page) {
    return page
      .locator(`${SIDEBAR} a[aria-current]`)
      .evaluateAll((els) =>
        els.map(
          (el) =>
            `${el.textContent?.trim()}=${el.getAttribute('aria-current')}`,
        ),
      )
  }

  /** The icon colour the browser actually paints for a top-level nav item. An
   * unlit item is `var(--fg-3)`; a lit one — an active leaf or an active section
   * parent — is `var(--ball-400)`. */
  async function navIconColor(page: Page, label: string) {
    return page
      .locator(SIDEBAR)
      .getByRole('link', { name: label, exact: true })
      .locator('.app-shell__nav-icon')
      .evaluate((el) => getComputedStyle(el).color)
  }

  /** A design token, resolved to the `rgb()` the browser paints, inside the
   * theme that owns it — so the assertion below names the *tint* rather than a
   * hard-coded triple that a palette change would silently invalidate. */
  async function resolvedColorToken(page: Page, token: string) {
    return page.locator('.app-shell').evaluate((host, name) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      host.appendChild(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }, token)
  }

  test('announces only the leaf on a sub-route, while the section stays lit', async ({
    page,
  }) => {
    await gotoWithSidebar(page, '/notifications/settings')
    await expect(
      page.locator(SIDEBAR).getByRole('link', { name: 'Preferences' }),
    ).toBeVisible()

    // Was ["Notifications=page", "Inbox=page", "Preferences=page"].
    expect(await currentPageLinks(page)).toEqual(['Preferences=page'])

    // The other half of the bargain: you can still SEE which section you are in.
    const notifications = page
      .locator(SIDEBAR)
      .getByRole('link', { name: 'Notifications', exact: true })
    await expect(notifications).toHaveClass(/is-parent-active/)
    // Not just the class — the paint. The parent's icon still carries the
    // section-lit accent, and is not the muted tint of an item you are not in.
    const lit = await navIconColor(page, 'Notifications')
    expect(lit).toBe(await resolvedColorToken(page, '--ball-400'))
    expect(lit).not.toBe(await navIconColor(page, 'Dashboard'))
  })

  test('announces Inbox on the notifications index, where the parent shares its URL', async ({
    page,
  }) => {
    await gotoWithSidebar(page, '/notifications')
    await expect(
      page.locator(SIDEBAR).getByRole('link', { name: 'Inbox' }),
    ).toBeVisible()

    // The hard case: Notifications and Inbox are the *same* URL, so no amount of
    // URL matching can pick a winner — only the leaf may announce itself.
    expect(await currentPageLinks(page)).toEqual(['Inbox=page'])
    await expect(
      page
        .locator(SIDEBAR)
        .getByRole('link', { name: 'Notifications', exact: true }),
    ).toHaveClass(/is-parent-active/)
  })

  test('announces the item itself on a plain top-level route', async ({
    page,
  }) => {
    await gotoWithSidebar(page, '/dashboard')

    // A childless item IS the leaf, so it keeps saying so — the fix narrows the
    // announcement, it does not remove it.
    expect(await currentPageLinks(page)).toEqual(['Dashboard=page'])
  })

  /**
   * The top-level items are no longer a bare `<Link>` — the shell now builds the
   * anchor itself from `useLinkProps()` so it can withhold `aria-current` from a
   * section parent. That anchor must still be a *router* link: drop the props the
   * hook hands back and every nav click becomes a full page load, which no other
   * test in this repo would notice (the URL still changes, the page still
   * renders — it is just slow and blows the client state away).
   *
   * A marker on `window` is the probe: a reload wipes it, a client-side
   * navigation does not. And since the route changes without a remount, this is
   * also the only test where `aria-current` has to *follow* the navigation
   * rather than being computed on a cold load.
   */
  test('navigates client-side, and the announcement follows the route', async ({
    page,
  }) => {
    await gotoWithSidebar(page, '/dashboard')
    await page.evaluate(() => {
      ;(window as Window & { __noReload?: boolean }).__noReload = true
    })

    await page
      .locator(SIDEBAR)
      .getByRole('link', { name: 'Notifications', exact: true })
      .click()

    await expect(page).toHaveURL(/\/notifications$/)
    expect(
      await page.evaluate(
        () => (window as Window & { __noReload?: boolean }).__noReload === true,
      ),
      'the page was not reloaded — the sidebar still navigates through the router',
    ).toBe(true)

    // Dashboard has stopped claiming to be the current page, and the section we
    // landed in hands the claim to its leaf, not to itself.
    expect(await currentPageLinks(page)).toEqual(['Inbox=page'])
  })
})

test.describe('Desktop sidebar (#887 must not over-reach)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('stays visible and fully navigable', async ({ page }) => {
    await gotoDashboard(page)

    const drawer = page.locator('#app-shell-sidebar')
    await expect(drawer).toBeVisible()
    // No drawer affordance above the breakpoint — this is a permanent sidebar.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden()

    const links = drawer.locator('a[href]')
    const count = await links.count()
    expect(count, 'nav links in the desktop sidebar').toBeGreaterThan(3)
    for (let i = 0; i < count; i++) {
      await links.nth(i).focus()
      await expect(links.nth(i), `nav link #${i} is focusable`).toBeFocused()
    }

    await expect(drawer.getByRole('link', { name: 'Matches' })).toBeVisible()
    expect(await offscreenTabbableCount(page)).toBe(0)
  })
})

/**
 * The topbar "Alpha" notice — a non-modal Radix popover.
 *
 * **#891 (the real bug)**: the open panel contained **zero** buttons. On a 375px
 * viewport it renders as a ~320×272 slab over most of the page, and its only
 * exits were an outside click and Escape — neither of which is something you can
 * see, and one of which a touch user does not have. The button-count assertion
 * below is the measurement from the issue, and it is the discriminating test:
 * it fails against the pre-fix shell.
 *
 * **#885 (not reproducible)**: "the alpha dialog does not close on Escape". It
 * does — verified in a browser on `main`, at both viewports, before anything was
 * changed. The Escape tests here are a **regression guard** for behaviour Radix's
 * `DismissableLayer` already gives us; they passed before this change too. They
 * exist so that a future `onEscapeKeyDown` preventDefault or a global key handler
 * that swallows Escape turns the suite red.
 *
 * Both viewports are exercised because the panel's harm (#891) is a mobile-layout
 * harm, while the a11y contract must hold everywhere.
 */
test.describe('Alpha notice (#891 close control, #885 Escape guard)', () => {
  const ALPHA_TRIGGER = 'About the alpha release'

  /** The popover's content: Radix gives it `role="dialog"`. */
  const notice = (page: Page) => page.getByRole('dialog')

  async function openAlphaNotice(page: Page) {
    await page.getByRole('button', { name: ALPHA_TRIGGER }).click()
    await expect(notice(page)).toBeVisible()
  }

  for (const [device, viewport] of [
    ['mobile', { width: 375, height: 667 }],
    ['desktop', { width: 1280, height: 800 }],
  ] as const) {
    test.describe(device, () => {
      test.use({ viewport })

      test('closes on a click of its visible, labelled close control (#891)', async ({
        page,
      }) => {
        await gotoDashboard(page)
        await openAlphaNotice(page)

        // The #891 measurement: this list was empty. Reading the *names* rather
        // than the count also pins that the control announces itself — an
        // unlabelled icon button would be no use to a screen-reader user.
        const buttons = notice(page).getByRole('button')
        expect(
          await buttons.evaluateAll((els) =>
            els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim()),
          ),
          'buttons inside the open alpha notice',
        ).toEqual(['Close alpha notice'])

        const close = notice(page).getByRole('button', { name: 'Close alpha notice' })
        // `.click()` is itself the proof a real user could reach it: Playwright
        // refuses to click an element that is hidden, zero-sized, or covered.
        await expect(close).toBeVisible()
        await close.click()

        await expect(notice(page)).toHaveCount(0)
        // Focus comes back to the badge rather than being stranded on a removed
        // node — a keyboard user can carry on tabbing from where they were.
        await expect(page.getByRole('button', { name: ALPHA_TRIGGER })).toBeFocused()
      })

      test('still closes on Escape — regression guard, not a fix (#885)', async ({
        page,
      }) => {
        await gotoDashboard(page)
        await openAlphaNotice(page)

        await page.keyboard.press('Escape')

        await expect(notice(page)).toHaveCount(0)
      })
    })
  }
})
