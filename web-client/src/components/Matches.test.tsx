import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Matches } from './Matches.tsx'

// The layout alone, as the parent of one child route, in a bare router of its
// own (renderScreen's router has no child routes) with none of the app's
// routes.
test('the matches layout shows the page under it', async () => {
  const rootRoute = createRootRoute()
  const layout = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches',
    component: Matches,
  })
  const child = createRoute({
    getParentRoute: () => layout,
    path: '/child',
    component: () => <h1>A page under /matches</h1>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([layout.addChildren([child])]),
    history: createMemoryHistory({ initialEntries: ['/matches/child'] }),
  })
  render(<RouterProvider router={router} />)

  expect(
    await screen.findByRole('heading', { name: 'A page under /matches' }),
  ).toBeVisible()
})
