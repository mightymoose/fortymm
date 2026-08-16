import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'

import { render, screen, type Container } from '@/test/utilities'

import {
  TournamentsListPage,
  type TournamentsListPageProps,
} from './tournaments-list-page'
import { buildTournamentsListPageProps } from './tournaments-list-page.factory'
import { tournamentsSearchSchema } from './data/search'
import { nearMeControlPage } from './near-me-control.page'
import { tournamentCardPage } from './tournament-card.page'

/** The router the most recent `render` built — held so `currentUrl()` can read back the
 * search string the tab strip and the search box navigated to. */
let router: AnyRouter | undefined

const scoped = (container: Container) => ({
  getSearch() {
    return container.getByLabelText(/Search tournaments/)
  },
  getStatusTab(label: string) {
    return container.getByRole('tab', { name: label })
  },
  /** Every status tab, in render order — so a test can assert the tab strip itself
   * rather than only that a named tab exists. */
  getStatusTabs(): HTMLElement[] {
    return container.getAllByRole('tab')
  },
  getNewButton() {
    return container.getAllByRole('button', { name: /New tournament/ })[0]
  },
  /** All "New tournament" actions — empty when the caller can't create. */
  queryNewButtons() {
    return container.queryAllByRole('button', { name: /New tournament/ })
  },
  getResultCount() {
    return container.getByText(/results?$/)
  },
  /** The `N total · N live` subtitle. */
  getSubtitle() {
    return container.getByText(/total ·/)
  },
  /** The empty panel's heading — the string that distinguishes the true-empty state
   * from the filtered-empty one. */
  queryEmptyTitle(title: string | RegExp) {
    return container.queryByText(title)
  },
  /** A card's open target, by tournament name. */
  getCard(name: string) {
    return container.getByRole('button', { name })
  },
  queryCard(name: string) {
    return container.queryByRole('button', { name })
  },
  /** The confirm button inside the delete dialog (portaled to the body). */
  getConfirmDeleteButton() {
    return screen.getByRole('button', { name: /^Delete$/ })
  },
  /** Reuse the card delete control query. */
  ...tournamentCardPage.within(container),
  /** The "Near me" toggle + radius picker live in the filter row. */
  nearMe: nearMeControlPage.within(container),
})

/**
 * Test page-object for `TournamentsListPage`.
 *
 * The page reads its status tab and search text from the URL (`useSearch`) and writes
 * them back (`useNavigate`), so it needs a `RouterProvider` — a bare render throws.
 * `render` therefore mounts it under a memory router whose `/tournaments` route carries
 * the **real** `tournamentsSearchSchema`, so a test exercises the same parse the app
 * does, degrading `?status=garbage` rather than throwing on it.
 *
 * The router resolves **asynchronously**, so every test starts with an `await find…()`.
 */
export const tournamentsListPagePage = {
  /** Await the router's first paint. Tests call this before any synchronous accessor
   * below, because the memory router resolves on a microtask. */
  findSearch() {
    return screen.findByLabelText(/Search tournaments/)
  },

  /** The URL the harness is currently on, path + search — how a test asserts what the
   * tab strip and the search box wrote. */
  currentUrl(): string {
    if (!router) throw new Error('currentUrl() called before render()')
    return router.state.location.href
  },

  /** How many entries the memory history holds — how a test proves a search replaces
   * the current entry instead of stacking one per keystroke. */
  historyLength(): number {
    if (!router) throw new Error('historyLength() called before render()')
    return router.history.length
  },

  /** Navigate the harness's router without unmounting the page — what the app shell's
   * own sidebar entry (`to: '/tournaments'`, no search) does to a page already showing
   * a filtered list. */
  navigateTo(to: string, search: Record<string, unknown> = {}) {
    if (!router) throw new Error('navigateTo() called before render()')
    return router.navigate({ to, search })
  },

  /**
   * Render under the memory-router harness. `initialEntry` deep-links the URL, which
   * is how the reload/restore and unrecognized-`status` cases are exercised.
   */
  render(
    overrides: Partial<TournamentsListPageProps> = {},
    initialEntry = '/tournaments',
  ) {
    const props = buildTournamentsListPageProps(overrides)
    const rootRoute = createRootRoute()
    const tournamentsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/tournaments',
      component: () => <TournamentsListPage {...props} />,
      validateSearch: zodValidator(tournamentsSearchSchema),
    })
    router = createRouter({
      routeTree: rootRoute.addChildren([tournamentsRoute]),
      history: createMemoryHistory({ initialEntries: [initialEntry] }),
    })
    render(<RouterProvider router={router} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
