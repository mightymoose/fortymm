import { act, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { Route } from './$userId'

const PlayerRoute = Route.options.component!

/** A page worth of opponent rows — only the fields the profile table reads. */
function matchRows(count: number, page: number, pageSize: number) {
  const start = (page - 1) * pageSize
  return Array.from({ length: Math.max(0, Math.min(pageSize, count - start)) })
    .map((_, i) => ({
      id: `m-${start + i}`,
      opponent: { id: `opp-${start + i}`, username: `opp.${start + i}` },
      games: [{ mine: 11, theirs: 7 }],
      result: 'W' as const,
      status: 'completed' as const,
      created_at: '2026-06-01T12:00:00Z',
      awaiting_acceptance: false,
    }))
}

function renderProfile(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId',
    component: PlayerRoute,
    validateSearch: Route.options.validateSearch,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([profileRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router }
}

describe('player profile match-history pagination', () => {
  it('snaps an out-of-range ?page= back to the last valid page (#637)', async () => {
    const TOTAL = 28 // 2 pages at page_size 25
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json({
          id: 'p-1',
          username: 'rallymaster',
          rating: 1234,
          wins: 20,
          losses: 8,
          // Bundled first page — the profile paints page 1 from this.
          matches: {
            items: matchRows(TOTAL, 1, 25),
            page: 1,
            page_size: 25,
            total: TOTAL,
          },
        }),
      ),
      http.get('*/v1/players/:playerId/matches', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1')
        // page 1 → 25 rows, page 2 → 3 rows, anything beyond → empty (but
        // still the real total, exactly as the server behaves).
        return HttpResponse.json({
          items: matchRows(TOTAL, page, 25),
          page,
          page_size: 25,
          total: TOTAL,
        })
      }),
    )

    const { router } = renderProfile('/players/p-1?page=999')

    // The clamp redirects to the last valid page (2), so the real rows render
    // instead of the cold "No matches yet" empty state under a broken footer.
    expect(await screen.findByText('opp.25')).toBeInTheDocument()
    expect(screen.queryByText(/no matches yet/i)).not.toBeInTheDocument()

    await waitFor(() => {
      expect(router.state.location.search).toEqual(
        expect.objectContaining({ page: 2 }),
      )
    })

    // Footer range is sane — start never exceeds the total.
    expect(screen.getByText(/showing/i).textContent).toContain('26–28')
    expect(screen.queryByText(/24951/)).not.toBeInTheDocument()
  })

  it('never flashes the cold empty state while redirecting an out-of-range page (#637)', async () => {
    const TOTAL = 28
    // Gate the last-valid-page (page 2) response so it stays in-flight while
    // we assert what renders during the redirect. `keepPreviousData` keeps
    // serving the empty out-of-range payload through this window, so a naive
    // guard would fall through to "No matches yet" until page 2 lands.
    let releasePage2: () => void = () => {}
    const page2Gate = new Promise<void>((resolve) => {
      releasePage2 = resolve
    })

    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json({
          id: 'p-1',
          username: 'rallymaster',
          rating: 1234,
          wins: 20,
          losses: 8,
          matches: {
            items: matchRows(TOTAL, 1, 25),
            page: 1,
            page_size: 25,
            total: TOTAL,
          },
        }),
      ),
      http.get('*/v1/players/:playerId/matches', async ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1')
        if (page === 2) await page2Gate
        return HttpResponse.json({
          items: matchRows(TOTAL, page, 25),
          page,
          page_size: 25,
          total: TOTAL,
        })
      }),
    )

    const { router } = renderProfile('/players/p-1?page=999')

    // The effect redirects to page 2; its fetch is gated, so we sit in the
    // redirect window with empty kept-previous rows.
    await waitFor(() => {
      expect(router.state.location.search).toEqual(
        expect.objectContaining({ page: 2 }),
      )
    })
    // The cold empty state must NOT show during the refetch — the skeleton
    // holds instead.
    expect(screen.queryByText(/no matches yet/i)).not.toBeInTheDocument()
    expect(document.querySelector('table[aria-busy="true"]')).not.toBeNull()

    // Release page 2 — the real rows replace the skeleton.
    await act(async () => {
      releasePage2()
    })
    expect(await screen.findByText('opp.25')).toBeInTheDocument()
    expect(screen.queryByText(/no matches yet/i)).not.toBeInTheDocument()
  })

  it('labels an awaiting-confirmation match "AWAITING", not "LIVE" (#364)', async () => {
    // Two in_progress rows: one genuinely live (no signature), one with a
    // posted-but-unconfirmed result. They must render distinct chips.
    const rows = [
      {
        id: 'm-awaiting',
        opponent: { id: 'opp-a', username: 'opp.awaiting' },
        games: [{ mine: 11, theirs: 9 }],
        result: null,
        status: 'in_progress' as const,
        created_at: '2026-06-02T12:00:00Z',
        awaiting_acceptance: true,
      },
      {
        id: 'm-live',
        opponent: { id: 'opp-l', username: 'opp.live' },
        games: [],
        result: null,
        status: 'in_progress' as const,
        created_at: '2026-06-01T12:00:00Z',
        awaiting_acceptance: false,
      },
    ]
    const bundle = { items: rows, page: 1, page_size: 25, total: rows.length }
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json({
          id: 'p-1',
          username: 'rallymaster',
          rating: 1234,
          wins: 20,
          losses: 8,
          matches: bundle,
        }),
      ),
      http.get('*/v1/players/:playerId/matches', () =>
        HttpResponse.json(bundle),
      ),
    )

    renderProfile('/players/p-1')

    // The awaiting row reads AWAITING; the live row still reads LIVE.
    expect(await screen.findByText('AWAITING')).toBeInTheDocument()
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    // The awaiting row must NOT be labelled LIVE.
    expect(screen.getAllByText('LIVE')).toHaveLength(1)
  })
})

/** The per-game score chips a row renders, in order, from the player's own
 * perspective (`mine` on top, `theirs` beneath). */
function gameChips() {
  return Array.from(
    document.querySelectorAll('.player-profile__game'),
  ).map((chip) => ({
    mine: chip.querySelector('.player-profile__game-mine')?.textContent,
    theirs: chip.querySelector('.player-profile__game-theirs')?.textContent,
    won: chip.classList.contains('player-profile__game--won'),
  }))
}

describe('player profile per-game score chips', () => {
  it('renders one chip per game, scored from the player’s perspective', async () => {
    // A 2–1 win: won the first, dropped the second, took the third. Distinct
    // scores in every game, so a chip that rendered the wrong game (or the
    // opponent's side of one) can't accidentally pass.
    const rows = [
      {
        id: 'm-scored',
        opponent: { id: 'opp-s', username: 'opp.scored' },
        games: [
          { mine: 11, theirs: 7 },
          { mine: 8, theirs: 11 },
          { mine: 12, theirs: 10 },
        ],
        result: 'W' as const,
        status: 'completed' as const,
        created_at: '2026-06-02T12:00:00Z',
        awaiting_acceptance: false,
      },
      {
        id: 'm-unscored',
        opponent: { id: 'opp-u', username: 'opp.unscored' },
        games: [],
        result: null,
        status: 'in_progress' as const,
        created_at: '2026-06-01T12:00:00Z',
        awaiting_acceptance: false,
      },
    ]
    const bundle = { items: rows, page: 1, page_size: 25, total: rows.length }
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json({
          id: 'p-1',
          username: 'rallymaster',
          rating: 1234,
          wins: 20,
          losses: 8,
          matches: bundle,
        }),
      ),
      http.get('*/v1/players/:playerId/matches', () =>
        HttpResponse.json(bundle),
      ),
    )

    renderProfile('/players/p-1')

    expect(await screen.findByText('opp.scored')).toBeInTheDocument()

    // Every game gets its own chip, in play order, with the real points — and
    // the won/lost tint follows the game, not the match.
    expect(gameChips()).toEqual([
      { mine: '11', theirs: '7', won: true },
      { mine: '8', theirs: '11', won: false },
      { mine: '12', theirs: '10', won: true },
    ])

    // A match with no scored games shows an em dash rather than an empty cell.
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
