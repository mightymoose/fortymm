import { http, HttpResponse } from 'msw'

import type { OpenTournamentCheckoutRead } from '@/mocks/factories/checkouts/open-checkout.factory'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import { OpenCheckoutBar } from './open-checkout-bar'

const scoped = (container: Container) => ({
  /** The bar itself — absent when the player has nothing open to show. */
  queryBar() {
    return container.queryByRole('region', { name: 'Open checkouts' })
  },
  async findBar() {
    return container.findByRole('region', { name: 'Open checkouts' })
  },
  /** The bar's one-line summary of the nearest checkout. */
  async findSummary() {
    return within(await this.findBar()).findByTestId('open-checkout-summary')
  },
})

/** Serve `GET /v1/me/checkouts/open`, one list per request (the last repeats),
 * and count the requests. */
export function mockOpenCheckouts(...responses: OpenTournamentCheckoutRead[][]) {
  const served = { count: 0 }
  server.use(
    http.get('*/v1/me/checkouts/open', () => {
      const list = responses[Math.min(served.count, responses.length - 1)]
      served.count += 1
      return HttpResponse.json(list)
    }),
  )
  return served
}

/** Test page-object for `OpenCheckoutBar`. Mount it at `path`, as a signed-in
 * page would; the bar reads the pathname and search to hide itself on the
 * checkout's own Events tab. */
export const openCheckoutBarPage = {
  render(path = '/dashboard') {
    renderWithRoutes(<OpenCheckoutBar />, {
      path: path.split('?')[0],
      initialEntry: path,
      linkTargets: ['/tournaments/$tournamentId'],
    })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
