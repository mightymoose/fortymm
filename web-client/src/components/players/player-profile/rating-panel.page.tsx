import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import { RatingPanel, type RatingPanelProps } from './rating-panel'
import { ratingPanelDisplayPage } from './rating-panel/rating-panel-fetcher/rating-panel-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** `RatingPanel`'s own `<Suspense>` fallback (the real `RatingPanelSkeleton`). */
  queryLoading() {
    return container.queryByRole('status', { name: /loading rating/i })
  },
  queryError() {
    return container.queryByRole('alert')
  },
  ...ratingPanelDisplayPage.within(container),
})

/**
 * Test page-object for the public `RatingPanel` wrapper — a `<Suspense>` with
 * its real skeleton around the fetcher, and no error boundary of its own.
 */
export const ratingPanelPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<RatingPanelProps> = {}) {
    const props: RatingPanelProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <RatingPanel {...props} />
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
