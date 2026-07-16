// Guards the *generated* route tree, not a synthetic one: the simulator
// prototype's route (`/simulator`) was deleted once its Gantt/player-timeline
// boards moved into the tournament Schedule tab, and nothing should quietly
// resurrect it. An unknown `/simulator` URL now falls through to the router's
// `defaultNotFoundComponent` like any other dead link (see
// `not-found-page.test.tsx` for that behaviour).
import { createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { routeTree } from '@/routeTree.gen'

describe('generated route tree', () => {
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
  })
  const routeIds = Object.keys(router.routesById)

  it('registers real routes (sanity check that the sweep sees the tree)', () => {
    expect(routeIds).toContain('/design-system')
    expect(routeIds.length).toBeGreaterThan(10)
  })

  it('no longer contains the deleted /simulator prototype route', () => {
    expect(routeIds).not.toContain('/simulator')
    expect(routeIds.filter((id) => id.includes('simulator'))).toEqual([])
  })
})
