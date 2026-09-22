import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'

import { routeTree } from '@/routeTree.gen'

it('matches the checkout as an app leaf instead of a tournament-detail child', async () => {
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({
      initialEntries: [
        '/tournaments/00000000-0000-4000-8000-000000000001/checkouts/00000000-0000-4000-8000-000000000002',
      ],
    }),
  })

  const matches = router.matchRoutes(router.history.location.pathname)
  const checkout = matches.find(
    (match) => match.fullPath === '/tournaments/$tournamentId/checkouts/$checkoutId',
  )

  expect(checkout).toBeDefined()
  expect(checkout?.routeId).not.toContain(
    '/_app/tournaments/$tournamentId/checkouts',
  )
  expect(matches.some((match) => match.routeId === '/_app/tournaments/$tournamentId')).toBe(false)
})
