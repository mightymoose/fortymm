import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import { YourGameRow, type YourGameRowProps } from './your-game-row'
import { buildYourGameRowProps } from './your-game-row.factory'
import { emptyCardPage } from './your-game-row/empty-card.page'
import { ratingCardPage } from './your-game-row/rating-card.page'
import { ratingCardSkeletonPage } from './your-game-row/rating-card-skeleton.page'
import { recentResultsCardPage } from './your-game-row/recent-results-card.page'
import { recentResultsCardSkeletonPage } from './your-game-row/recent-results-card-skeleton.page'
import { sectionHeaderPage } from './your-game-row/section-header.page'

const scoped = (container: Container) => {
  // Compose the header's own query surface rather than re-deriving its
  // heading/subtitle/action-link queries here.
  const sectionHeader = sectionHeaderPage.within(container)
  return {
    /** The "Your game" section heading. */
    getHeading() {
      return sectionHeader.getHeading('Your game')
    },
    /** The subtitle line (strategy label + window), or null when absent. */
    querySubtitle(text: string | RegExp) {
      return sectionHeader.querySubtitle(text)
    },
    /** The "Full history" link in the header. */
    getFullHistoryLink() {
      return sectionHeader.getActionLink(/full history/i)
    },
    // Wiring surfaces for the two grid slots; the children's internals are
    // pinned by their own quartets — here we only confirm the right child was
    // rendered.
    ratingCard: ratingCardPage.within(container),
    recentResults: recentResultsCardPage.within(container),
    emptyCard: emptyCardPage.within(container),
    ratingSkeleton: ratingCardSkeletonPage.within(container),
    recentResultsSkeleton: recentResultsCardSkeletonPage.within(container),
  }
}

/**
 * Test page-object for `YourGameRow`. Its header carries a "Full history"
 * `<Link>`, so `render` mounts the row under a memory router registering
 * `/matches` (and `/`). The router resolves asynchronously, so tests start with
 * `await yourGameRowPage.findHeading()`.
 */
export const yourGameRowPage = {
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
    render(<RouterProvider router={router} />)
  },

  /** Async-first accessor — the router resolves the route tree on first paint,
   * so tests await this before reading the synchronous accessors. */
  findHeading() {
    return screen.findByRole('heading', { name: 'Your game' })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
