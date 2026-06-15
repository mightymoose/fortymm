import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, within, type Container } from '@/test/utilities'

import { YourGameRow, type YourGameRowProps } from './your-game-row'
import { buildYourGameRowProps } from './your-game-row.factory'
import { ratingCardPage } from './your-game-row/rating-card.page'
import { recentResultsCardPage } from './your-game-row/recent-results-card.page'

const scoped = (container: Container) => ({
  /** The "Your game" section heading. */
  getHeading() {
    return container.getByRole('heading', { level: 2, name: /your game/i })
  },
  /** The strategy/window subtitle text. */
  getSubtitle(text: string) {
    return container.getByText(text)
  },
  /** The "Full history" link to /matches. */
  getFullHistoryLink() {
    return container.getByRole('link', { name: /full history/i })
  },
  /** The rating-column loading placeholder, present only while loading. */
  queryRatingSkeleton() {
    return container.queryByRole('status', { name: /loading rating/i })
  },
  /** The recent-column loading placeholder, present only while loading. */
  queryRecentSkeleton() {
    return container.queryByRole('status', { name: /loading recent/i })
  },
  /** The "Not in a rated league yet." empty state, present when unrated. */
  queryRatingEmpty() {
    return container.queryByText(/not in a rated league/i)
  },
})

/**
 * Test page-object for `YourGameRow`. The section header renders a typed
 * `<Link>` to /matches, so `render` mounts it under a minimal memory router.
 * The router resolves asynchronously, so tests start with
 * `await yourGameRowPage.findHeading()`. The rating and recent cards are queried
 * through their own composed page objects.
 */
export const yourGameRowPage = {
  root: null as HTMLElement | null,

  render(overrides: Partial<YourGameRowProps> = {}) {
    const props = buildYourGameRowProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <YourGameRow {...props} />,
    })
    const matchesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches',
      component: () => <div>matches</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, matchesRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    const { container } = render(<RouterProvider router={router} />)
    this.root = container
  },

  /** Async-first accessor — the router resolves on first paint, so tests await
   * this before reading the synchronous accessors. */
  findHeading() {
    return screen.findByRole('heading', { level: 2, name: /your game/i })
  },

  /** The composed rating-card page object, scoped to this section. */
  rating() {
    if (!this.root) throw new Error('Call render() before rating()')
    return ratingCardPage.within(this.root)
  },

  /** The composed recent-results-card page object, scoped to this section. */
  recent() {
    if (!this.root) throw new Error('Call render() before recent()')
    return recentResultsCardPage.within(this.root)
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
