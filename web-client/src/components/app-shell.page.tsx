import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'

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

  return {
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
  }
}

/**
 * Test page-object for `AppShell`. `render(pathname)` mounts the shell under a
 * memory router seeded at that pathname (the only input its nav-highlighting
 * cares about) with every nav link target registered as a stub route. The
 * router and the session query both resolve asynchronously, so tests start with
 * `await appShellPage.findNavLink(...)`.
 *
 * Active state is asserted through the BEM classes, not `aria-current`: a
 * TanStack `<Link>` stamps `aria-current="page"` (plus `data-status="active"`)
 * on *every* link whose `to` is a prefix of the location — its default
 * `activeOptions.exact` is `false` — so the parent items and the Inbox child
 * all carry it regardless of what the shell decides. The `is-active` /
 * `is-parent-active` classes are the shell's own contract (they drive the CSS
 * and the e2e locators), so they're what these accessors read.
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
