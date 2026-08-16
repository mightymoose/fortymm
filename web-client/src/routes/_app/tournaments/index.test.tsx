import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { zodValidator } from '@tanstack/zod-adapter'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { tournamentsSearchSchema } from '@/components/tournaments/data/search'
import { Route } from './index'

const TournamentsRoute = Route.options.component!

const NEAR = 'Near Club Open'
const FAR = 'Far Away Classic'

/** Install a granted geolocation whose position resolves synchronously. */
function grantGeolocation(lat = 37.7749, lng = -122.4194) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (success: PositionCallback) =>
        success({ coords: { latitude: lat, longitude: lng } } as GeolocationPosition),
    },
  })
}

/** A denied geolocation — the error callback fires. */
function denyGeolocation() {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (
        _success: PositionCallback,
        error?: PositionErrorCallback,
      ) =>
        error?.({
          code: 1,
          message: 'User denied Geolocation',
        } as GeolocationPositionError),
    },
  })
}

/** The list endpoint, near-me-aware: with no location it returns BOTH rows
 * (the full list); with a location it filters to what falls inside the radius —
 * only `NEAR` at 25/50 mi, and both once the radius opens to 100 mi. This
 * mirrors the real server + the MSW store contract (chore 3b), so the whole
 * wire round-trip (lat/lng/radius_miles → filtered rows + `distance_miles`) is
 * exercised. Returns the last-seen URL for the param assertion. */
function installList(): { lastUrl: () => string } {
  let url = ''
  const near = buildTournamentDetailRead({ id: 'near', name: NEAR })
  const far = buildTournamentDetailRead({ id: 'far', name: FAR })
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    http.get('*/v1/tournaments', ({ request }) => {
      url = request.url
      const params = new URL(request.url).searchParams
      const lat = params.get('lat')
      if (!lat) return HttpResponse.json([near, far])
      const radius = Number(params.get('radius_miles'))
      const rows =
        radius >= 100
          ? [
              { ...near, distance_miles: 4.2 },
              { ...far, distance_miles: 88.6 },
            ]
          : [{ ...near, distance_miles: 4.2 }]
      return HttpResponse.json(rows)
    }),
  )
  return { lastUrl: () => url }
}

function renderRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tournaments/',
    component: TournamentsRoute,
    // The real route's validator, not a stand-in: without it `useSearch` inside
    // `TournamentsListPage` hands back raw, unparsed search and these tests would
    // exercise a page the app never renders.
    validateSearch: zodValidator(tournamentsSearchSchema),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/tournaments'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const toggle = () => screen.getByRole('switch', { name: /near me/i })
const card = (name: string) => screen.queryByRole('button', { name })

afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: undefined,
  })
})

describe('tournaments list — Near me filter', () => {
  it('enabling with a granted location fires the list query with lat/lng/radius_miles and narrows the list', async () => {
    grantGeolocation()
    const list = installList()
    renderRoute()

    // The full list loads first — both venues visible.
    await screen.findByRole('button', { name: NEAR })
    expect(card(FAR)).toBeInTheDocument()

    await userEvent.click(toggle())

    // The far venue drops out once the near-me query resolves; the near one stays.
    await waitFor(() => expect(card(NEAR)).toBeInTheDocument())
    expect(card(FAR)).toBeNull()

    // The wire carried the all-or-nothing triple.
    const params = new URL(list.lastUrl()).searchParams
    expect(params.get('lat')).toBe('37.7749')
    expect(params.get('lng')).toBe('-122.4194')
    expect(params.get('radius_miles')).toBe('25')
  })

  it('changing the radius re-queries — widening to 100 mi brings the far venue back', async () => {
    grantGeolocation()
    const list = installList()
    renderRoute()

    await screen.findByRole('button', { name: NEAR })
    await userEvent.click(toggle())
    await waitFor(() => expect(card(NEAR)).toBeInTheDocument())
    expect(card(FAR)).toBeNull()

    // Open the radius picker and widen to 100 mi.
    await userEvent.click(screen.getByRole('combobox', { name: /search radius/i }))
    await userEvent.click(await screen.findByRole('option', { name: '100 mi' }))

    // The list re-fetches at the new radius and the far venue reappears.
    await waitFor(() => expect(card(FAR)).toBeInTheDocument())
    expect(new URL(list.lastUrl()).searchParams.get('radius_miles')).toBe('100')
  })

  it('a denied location falls back: the full list stays and an inline note shows', async () => {
    denyGeolocation()
    installList()
    renderRoute()

    await screen.findByRole('button', { name: NEAR })
    await userEvent.click(toggle())

    // No filtering — both venues remain — and the note explains why.
    expect(card(NEAR)).toBeInTheDocument()
    expect(card(FAR)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/location unavailable/i)
    // The toggle snapped back off — no permanent spinner, no crash.
    expect(toggle()).not.toBeChecked()
  })
})
