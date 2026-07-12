import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'

import { mockSession } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { render, screen, within, type Container } from '@/test/utilities'

import { AppShell, type AppShellProps } from './app-shell'
import { buildAppShellProps } from './app-shell.factory'

/**
 * Every `<Link>` target the sidebar can render (top-level items + sub-nav
 * children). They're registered as stub routes so the typed links resolve at
 * render time. The *pathnames tests render at* (e.g. `/players/u_7`) do NOT
 * need to be here: the shell reads `location.pathname` from history, which is
 * populated whether or not a route matches.
 */
const NAV_LINK_PATHS = [
  '/dashboard',
  '/matches',
  '/players',
  '/tournaments',
  '/notifications',
  '/notifications/settings',
  '/admin',
  '/admin/roles',
  '/admin/permissions',
  '/admin/users',
  '/admin/broadcast',
]

/** Trimmed label of a nav link (the icon `<span>` contributes no text). */
const labelOf = (el: Element) => el.textContent?.trim() ?? ''

const scoped = (container: Container) => {
  const sidebar = (): HTMLElement =>
    container.getByRole('complementary', { name: 'Main navigation' })
  const labels = (selector: string) =>
    Array.from(sidebar().querySelectorAll<HTMLAnchorElement>(selector)).map(
      labelOf,
    )
  const alphaTrigger = (): HTMLElement =>
    container.getByRole('button', { name: 'About the alpha release' })

  return {
    /** The `<aside>` itself — the drawer on mobile, the sidebar on desktop. */
    getSidebar() {
      return sidebar()
    },
    /**
     * The topbar hamburger. Its `aria-controls` must resolve to the sidebar's
     * `id`; whether the *closed* drawer is actually out of the tab order is a
     * question about layout, so it's pinned in `e2e/app-shell.spec.ts` — jsdom
     * cannot see the CSS that hides it.
     */
    getMenuButton() {
      return container.getByRole('button', { name: 'Open navigation' })
    },
    /**
     * Any nav link in the sidebar by its label — top-level ("Matches") or
     * sub-nav ("Preferences"); the labels are unique across both levels.
     */
    getNavLink(label: string) {
      return within(sidebar()).getByRole('link', { name: label })
    },
    /**
     * Async variant, and the way every test starts: the router mounts on a
     * tick, and permission-gated items (Tournaments, Administration and its
     * children) only appear once `/v1/session` resolves. Await one of those
     * before reading any active state synchronously.
     */
    async findNavLink(label: string) {
      const bar = await container.findByRole('complementary', {
        name: 'Main navigation',
      })
      return within(bar).findByRole('link', { name: label })
    },

    /**
     * Labels of the top-level items carrying the full active treatment
     * (`.app-shell__nav-link.is-active`). Empty when nothing is active.
     */
    getActiveNavLabels() {
      return labels('.app-shell__nav-link.is-active')
    },
    /**
     * Labels of the top-level items carrying only the icon-tint treatment
     * (`.is-parent-active`) — an item with children never takes `is-active`.
     */
    getParentActiveNavLabels() {
      return labels('.app-shell__nav-link.is-parent-active')
    },
    /** Labels of the active sub-nav children (`.app-shell__sub-nav-link.is-active`). */
    getActiveSubNavLabels() {
      return labels('.app-shell__sub-nav-link.is-active')
    },
    /**
     * Labels of every sidebar link — both levels — announced to assistive tech
     * as the current page. This is the *semantic* layer, not the visual one, and
     * the two deliberately disagree: on `/notifications/settings` the parent is
     * lit but says nothing, so this returns `['Preferences']` while
     * `getParentActiveNavLabels()` returns `['Notifications']`. ARIA has exactly
     * one current page, so this list should never hold more than one label
     * (#930).
     */
    getCurrentPageNavLabels() {
      return labels('a[aria-current="page"]')
    },
    /** Every value of `aria-current` in the sidebar — `aria-current="true"` on a
     * section ancestor would be just as wrong as a second `"page"`, and only a
     * value-blind sweep can see it. */
    getAriaCurrentValues() {
      return Array.from(
        sidebar().querySelectorAll<HTMLAnchorElement>('a[aria-current]'),
      ).map((el) => `${labelOf(el)}=${el.getAttribute('aria-current')}`)
    },

    // --- The alpha notice (topbar) ---------------------------------------
    //
    // Radix portals the popover's content to `document.body`, *outside* the
    // shell's tree, so the notice accessors read from `screen` rather than
    // from `container`. Only the trigger — a real topbar child — is scoped.

    /** The topbar "Alpha" badge that opens the notice. */
    getAlphaTrigger() {
      return alphaTrigger()
    },
    /** Click the badge and wait for the notice. Radix renders popover content
     * with `role="dialog"` (it is not modal — Escape and an outside click both
     * dismiss it — but the role is a dialog all the same). */
    async openAlphaNotice() {
      await userEvent.click(alphaTrigger())
      return await screen.findByRole('dialog')
    },
    /** The open notice, or `null` once it is dismissed. */
    queryAlphaNotice() {
      return screen.queryByRole('dialog')
    },
    /**
     * The notice's close control, addressed by its accessible name — the whole
     * point of #891 is that a control exists *and* announces itself. Throws
     * when there is none, which is exactly what the pre-fix shell did.
     */
    getAlphaCloseButton() {
      return within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Close alpha notice',
      })
    },
    /**
     * Every button inside the open notice. Before #891 this was **empty** — the
     * panel covered most of a 375px viewport with nothing to press. Asserting
     * the list (not just "a close button exists") also catches a second, unnamed
     * dismiss affordance sneaking in.
     */
    getAlphaNoticeButtonNames() {
      return within(screen.getByRole('dialog'))
        .queryAllByRole('button')
        .map((el) => el.getAttribute('aria-label') ?? labelOf(el))
    },
  }
}

/**
 * Test page-object for `AppShell`. `render(pathname)` mounts the shell under a
 * memory router seeded at that pathname (the only input its nav-highlighting
 * cares about) with every nav link target registered as a stub route. The
 * router and the session query both resolve asynchronously, so tests start with
 * `await appShellPage.findNavLink(...)`.
 *
 * The shell has **two** notions of "current", and they are read separately:
 *
 * - **Visual** — the `is-active` / `is-parent-active` BEM classes the shell
 *   computes itself (`getActiveNavLabels`, `getParentActiveNavLabels`,
 *   `getActiveSubNavLabels`). A section parent is lit across its whole subtree.
 * - **Semantic** — `aria-current="page"` (`getCurrentPageNavLabels`,
 *   `getAriaCurrentValues`). Only the leaf; a parent announces nothing.
 *
 * They must be asserted together. The classes drive the CSS and no CSS reads
 * `aria-current`, so a change that quietly dimmed the parent would still satisfy
 * an `aria-current`-only test, and vice versa (#930).
 */
export const appShellPage = {
  render(pathname: string, overrides: Partial<AppShellProps> = {}) {
    // The default handler sleeps 600ms to make the dev UI's loading states
    // visible. The permission-gated items (Tournaments, Administration) can't
    // render until this resolves, so tests would pay it as real wall clock.
    server.use(http.get('*/v1/session', () => HttpResponse.json(mockSession)))

    const props = buildAppShellProps(overrides)
    const rootRoute = createRootRoute({ component: () => <AppShell {...props} /> })
    const routes = NAV_LINK_PATHS.map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: () => <div>{path}</div>,
      }),
    )
    const router = createRouter({
      routeTree: rootRoute.addChildren(routes),
      history: createMemoryHistory({ initialEntries: [pathname] }),
    })
    render(<RouterProvider router={router} />)
  },

  /** Scope the accessors to a container — the whole `screen` by default. */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
