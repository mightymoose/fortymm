import { act, render, screen, waitFor, within } from '@testing-library/react'
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
import { Route } from './$userId_.matches'

const MatchHistoryRoute = Route.options.component!

/**
 * A distinct, well-formed match id. Match ids are **UUIDs** on the wire, and the
 * `$matchId` route guard (`src/lib/match-id.ts`) rejects anything else — so the
 * rows every row-link assertion is made against have to carry real ones.
 */
const matchId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A page worth of opponent rows — only the fields the history table reads. */
function matchRows(count: number, page: number, pageSize: number) {
  const start = (page - 1) * pageSize
  return Array.from({ length: Math.max(0, Math.min(pageSize, count - start)) })
    .map((_, i) => ({
      id: matchId(start + i),
      opponent: { id: `opp-${start + i}`, username: `opp.${start + i}` },
      games: [{ mine: 11, theirs: 7 }],
      result: 'W' as const,
      status: 'completed' as const,
      created_at: '2026-06-01T12:00:00Z',
      awaiting_acceptance: false,
    }))
}

/** The profile bundle the heading reads. Post-overview shape: six recent
 * matches (NOT a page of 25) plus the all-inclusive `match_total`. The history
 * page must not paint its 25-per-page table from this. */
function profileBundle(matchTotal: number) {
  return {
    id: 'p-1',
    username: 'rallymaster',
    rating: 1234,
    wins: 20,
    losses: 8,
    form: 'WWLWW',
    rank: 3,
    match_total: matchTotal,
    matches: {
      items: matchRows(matchTotal, 1, 6),
      page: 1,
      page_size: 6,
      total: matchTotal,
    },
  }
}

function renderHistory(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  // The back link targets the profile route, so the harness needs it in the
  // tree for `<Link to="/players/$userId">` to resolve.
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId',
    component: () => null,
  })
  const historyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId/matches',
    component: MatchHistoryRoute,
    validateSearch: Route.options.validateSearch,
  })
  // Every row is a typed <Link> to its match (#989), so the detail route must be
  // in the tree for those links to resolve.
  const matchDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => <div>match detail</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      profileRoute,
      historyRoute,
      matchDetailRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router }
}

describe('player match history', () => {
  it('renders the all-inclusive history 25 to a page under the player’s name', async () => {
    // ADR-0008: every match the player is a side of, any status — a live one,
    // one awaiting acceptance, a voided one and the player-less solo sentinel
    // all belong here. 26 total → 25 on page 1, so the page is full.
    const rows = [
      {
        id: matchId(101),
        opponent: { id: 'opp-l', username: 'opp.live' },
        games: [],
        result: null,
        status: 'in_progress' as const,
        created_at: '2026-06-05T12:00:00Z',
        awaiting_acceptance: false,
      },
      {
        id: matchId(102),
        // The solo sentinel side: no opponent id, no username.
        opponent: { id: null, username: null },
        games: [{ mine: 11, theirs: 4 }],
        result: 'W' as const,
        status: 'completed' as const,
        created_at: '2026-06-04T12:00:00Z',
        awaiting_acceptance: false,
      },
      {
        id: matchId(103),
        opponent: { id: 'opp-v', username: 'opp.voided' },
        games: [],
        result: null,
        status: 'voided' as const,
        created_at: '2026-06-03T12:00:00Z',
        awaiting_acceptance: false,
      },
      {
        id: matchId(104),
        opponent: { id: 'opp-p', username: 'opp.pending' },
        games: [],
        result: null,
        status: 'pending' as const,
        created_at: '2026-06-02T12:00:00Z',
        awaiting_acceptance: false,
      },
      ...matchRows(26, 1, 25).slice(0, 21),
    ]
    const TOTAL = 26
    const requestedPageSizes: (string | null)[] = []

    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json(profileBundle(TOTAL)),
      ),
      http.get('*/v1/players/:playerId/matches', ({ request }) => {
        requestedPageSizes.push(
          new URL(request.url).searchParams.get('page_size'),
        )
        return HttpResponse.json({
          items: rows,
          page: 1,
          page_size: 25,
          total: TOTAL,
        })
      }),
    )

    renderHistory('/players/p-1/matches')

    // The heading names the player — read from the profile bundle.
    expect(await screen.findByText('rallymaster')).toBeInTheDocument()
    expect(screen.getByText(/match history/i)).toBeInTheDocument()

    // A full page of 25 rows — the six-match profile bundle must not be the
    // source of this table.
    await waitFor(() => {
      expect(document.querySelectorAll('table.matches tbody tr')).toHaveLength(
        25,
      )
    })

    // …and nothing is filtered out of it: in-play, up-next, voided and solo
    // rows are all present.
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('UP NEXT')).toBeInTheDocument()
    expect(screen.getByText('VOIDED')).toBeInTheDocument()
    expect(screen.getByText('No opponent')).toBeInTheDocument()

    // The footer counts the whole inclusive history, not just this page.
    expect(screen.getByText(/showing/i).textContent).toContain('1–25')
    expect(screen.getByText(/showing/i).textContent).toContain('26')

    // The table asked the *matches* endpoint for a real 25-row page — it never
    // rendered off the profile bundle's six.
    expect(requestedPageSizes).toEqual(['25'])
  })

  it('snaps an out-of-range ?page= back to the last valid page (#637)', async () => {
    const TOTAL = 28 // 2 pages at page_size 25
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json(profileBundle(TOTAL)),
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

    const { router } = renderHistory('/players/p-1/matches?page=999')

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
        HttpResponse.json(profileBundle(TOTAL)),
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

    const { router } = renderHistory('/players/p-1/matches?page=999')

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

  it('links every row through to its match — a real href, one anchor (#989)', async () => {
    // The issue: the history rows weren't clickable at all. They are now — and
    // through a genuine `<a href="/matches/<uuid>">`, not a `role="link"` `<tr>`
    // with an onClick, which cannot be cmd-clicked, middle-clicked or opened in
    // a new tab. So the assertion is the URL, per row, not "a link exists".
    const rows = [
      ...matchRows(2, 1, 25),
      {
        id: matchId(102),
        opponent: { id: null, username: null },
        games: [{ mine: 11, theirs: 4 }],
        result: 'W' as const,
        status: 'completed' as const,
        created_at: '2026-06-04T12:00:00Z',
        awaiting_acceptance: false,
      },
    ]
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json(profileBundle(rows.length)),
      ),
      http.get('*/v1/players/:playerId/matches', () =>
        HttpResponse.json({
          items: rows,
          page: 1,
          page_size: 25,
          total: rows.length,
        }),
      ),
    )

    renderHistory('/players/p-1/matches')

    const firstRow = (await screen.findByText('opp.0')).closest('tr')!
    const firstLink = within(firstRow).getByRole('link')
    expect(firstLink).toHaveAttribute('href', `/matches/${matchId(0)}`)

    // Each row points at its OWN match — a hardcoded target would pass above.
    const secondRow = screen.getByText('opp.1').closest('tr')!
    expect(within(secondRow).getByRole('link')).toHaveAttribute(
      'href',
      `/matches/${matchId(1)}`,
    )

    // Exactly one anchor per row: the link is stretched across the row with a
    // `::after`, so a screen reader hears it once, named for the match — not
    // named for the opponent, whose profile it does not open.
    expect(within(firstRow).getAllByRole('link')).toHaveLength(1)
    expect(firstLink.getAttribute('aria-label')).toMatch(
      /^Match against opp\.0, /,
    )

    // The solo sentinel row (ADR-0008) is a real match too — it opens, and it is
    // not announced as a match "against No opponent".
    const soloRow = screen.getByText('No opponent').closest('tr')!
    const soloLink = within(soloRow).getByRole('link')
    expect(soloLink).toHaveAttribute('href', `/matches/${matchId(102)}`)
    expect(soloLink.getAttribute('aria-label')).toMatch(/^Solo match, /)
  })

  it('labels an awaiting-confirmation match "AWAITING", not "LIVE" (#364)', async () => {
    // Two in_progress rows: one genuinely live (no signature), one with a
    // posted-but-unconfirmed result. They must render distinct chips.
    const rows = [
      {
        id: matchId(105),
        opponent: { id: 'opp-a', username: 'opp.awaiting' },
        games: [{ mine: 11, theirs: 9 }],
        result: null,
        status: 'in_progress' as const,
        created_at: '2026-06-02T12:00:00Z',
        awaiting_acceptance: true,
      },
      {
        id: matchId(101),
        opponent: { id: 'opp-l', username: 'opp.live' },
        games: [],
        result: null,
        status: 'in_progress' as const,
        created_at: '2026-06-01T12:00:00Z',
        awaiting_acceptance: false,
      },
    ]
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json(profileBundle(rows.length)),
      ),
      http.get('*/v1/players/:playerId/matches', () =>
        HttpResponse.json({
          items: rows,
          page: 1,
          page_size: 25,
          total: rows.length,
        }),
      ),
    )

    renderHistory('/players/p-1/matches')

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
  return Array.from(document.querySelectorAll('.player-profile__game')).map(
    (chip) => ({
      mine: chip.querySelector('.player-profile__game-mine')?.textContent,
      theirs: chip.querySelector('.player-profile__game-theirs')?.textContent,
      won: chip.classList.contains('player-profile__game--won'),
    }),
  )
}

describe('player match history per-game score chips', () => {
  it('renders one chip per game, scored from the player’s perspective', async () => {
    // A 2–1 win: won the first, dropped the second, took the third. Distinct
    // scores in every game, so a chip that rendered the wrong game (or the
    // opponent's side of one) can't accidentally pass.
    const rows = [
      {
        id: matchId(106),
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
        id: matchId(107),
        opponent: { id: 'opp-u', username: 'opp.unscored' },
        games: [],
        result: null,
        status: 'in_progress' as const,
        created_at: '2026-06-01T12:00:00Z',
        awaiting_acceptance: false,
      },
    ]
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json(profileBundle(rows.length)),
      ),
      http.get('*/v1/players/:playerId/matches', () =>
        HttpResponse.json({
          items: rows,
          page: 1,
          page_size: 25,
          total: rows.length,
        }),
      ),
    )

    renderHistory('/players/p-1/matches')

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
