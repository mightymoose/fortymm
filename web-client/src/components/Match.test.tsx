import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { matchMemory } from '../stores/match-memory.ts'
import { matchStore, useMatch } from '../stores/match.ts'
import { createMatch } from '../test/match.ts'
import { Match } from './Match.tsx'

// The match layout alone, as the parent of one child route, in a bare router
// of its own, against the app's real match store: it shows the page under it,
// and while it is mounted a change to the match made elsewhere (straight to
// the memory, as another store or tab would) shows on that page. Unwatched,
// the store drops the entry instead (src/stores/match.test.ts).
test('the match layout shows the page under it, and a change made elsewhere to the match shows on it', async () => {
  const matchId = await createMatch(5)
  await matchStore.getState().load(matchId)
  const rootRoute = createRootRoute()
  const layout = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => <Match matchId={matchId} />,
  })
  const child = createRoute({
    getParentRoute: () => layout,
    path: '/child',
    component: function Games() {
      const entry = useMatch(matchId)
      return (
        <h1>{entry?.status === 'ready' ? `${entry.match.games.length} games` : 'No match'}</h1>
      )
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([layout.addChildren([child])]),
    history: createMemoryHistory({ initialEntries: [`/matches/${matchId}/child`] }),
  })
  render(<RouterProvider router={router} />)
  expect(await screen.findByRole('heading', { name: '0 games' })).toBeVisible()

  await matchMemory.saveGame(matchId, 1, () => ({ score: [11, 7] }))

  expect(await screen.findByRole('heading', { name: '1 games' })).toBeVisible()
})
