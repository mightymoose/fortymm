import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import { CareerCard, type CareerCardProps } from './career-card'
import { careerCardDisplayPage } from './career-card/career-card-fetcher/career-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** `CareerCard`'s own `<Suspense>` fallback (the real `CareerCardSkeleton`)
   * while the bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading career/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading career/i })
  },
  /** The fallback rendered by the *ancestor* error boundary — the card owns
   * none. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...careerCardDisplayPage.within(container),
})

/**
 * Test page-object for the public `CareerCard` wrapper. It adds only a
 * `<Suspense>` (with its real skeleton) around the fetcher and deliberately has
 * no error boundary, so this renders it beneath the boundary the route supplies
 * in production.
 */
export const careerCardPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<CareerCardProps> = {}) {
    const props: CareerCardProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <CareerCard {...props} />
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
