import { render, screen, waitFor, within } from '@testing-library/react'
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
import { Route } from './index'

const PlayersRoute = Route.options.component!

/** A PlayerSummary row — only the fields the roster table reads. `rank` is the
 * player's true global rating rank (1 = highest); `null` means unrated. */
function playerRow(
  overrides: {
    id: string
    username: string
    rank: number | null
    rating?: number | null
  },
) {
  return {
    rating: 1500,
    wins: 10,
    losses: 5,
    form: 'WWLWL',
    ...overrides,
  }
}

function renderRoster(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const rosterRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/',
    component: PlayersRoute,
    validateSearch: Route.options.validateSearch,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([rosterRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Find the row whose player-name cell reads `username`, then return its
 * rank/seed span so the assertions don't collide with the em-dashes the
 * rating/form cells also render for unrated/empty players. */
function seedSpanFor(username: string): HTMLElement {
  const row = screen.getByText(username).closest('tr')
  if (!row) throw new Error(`no row for ${username}`)
  const span = within(row).getByText((_, el) =>
    el?.classList.contains('players-seed') ?? false,
  )
  return span
}

describe('players roster rank column (#841)', () => {
  it('renders true global ranks, gilds the top 4, and shows an em-dash for unrated', async () => {
    const items = [
      playerRow({ id: 'p-1', username: 'ace.top', rank: 1 }),
      playerRow({ id: 'p-2', username: 'mid.player', rank: 7 }),
      playerRow({
        id: 'p-3',
        username: 'unrated.rookie',
        rank: null,
        rating: null,
      }),
    ]
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players', () =>
        HttpResponse.json({
          items,
          page: 1,
          page_size: 25,
          total: items.length,
        }),
      ),
    )

    renderRoster('/players')

    // Rows render once the list resolves.
    await screen.findByText('ace.top')

    // Ranked rows show `#N`.
    const topSeed = seedSpanFor('ace.top')
    expect(topSeed.textContent).toBe('#1')
    const midSeed = seedSpanFor('mid.player')
    expect(midSeed.textContent).toBe('#7')

    // A top-4 rank IS gilded gold.
    expect(topSeed.classList.contains('players-seed--top')).toBe(true)
    // A rank outside the top 4 is NOT gilded.
    expect(midSeed.classList.contains('players-seed--top')).toBe(false)

    // The unrated row shows the em-dash and is NOT gilded — the null guard
    // matters because `null <= 4` is truthy in JS.
    const unratedSeed = seedSpanFor('unrated.rookie')
    expect(unratedSeed.textContent).toBe('—')
    expect(unratedSeed.classList.contains('players-seed--top')).toBe(false)
  })

  it('captions the stat cells with their column names, leaving name + seed bare (#900)', async () => {
    const items = [playerRow({ id: 'p-1', username: 'ace.top', rank: 1 })]
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players', () =>
        HttpResponse.json({ items, page: 1, page_size: 25, total: items.length }),
      ),
    )

    renderRoster('/players')
    await screen.findByText('ace.top')

    // Below 640px the shared match-list stylesheet hides the thead and re-adds
    // each column's name inside the card via `td[data-label]::before`. Zip the
    // header cells against the row's cells so we assert the caption *equals the
    // column it stands in for* — retyping the strings here would let a mismatched
    // dash ("W-L" vs "W–L") pass while the mobile caption disagreed with desktop.
    const row = screen.getByText('ace.top').closest('tr')!
    const headers = [
      ...row.closest('table')!.querySelectorAll('thead th'),
    ].map((th) => th.textContent)
    const labels = [...row.querySelectorAll('td')].map(
      (td) => td.dataset.label ?? null,
    )
    expect(headers).toHaveLength(labels.length)

    // Rating / W–L / Form each caption themselves with their column's own words.
    expect(labels[2]).toBe(headers[2])
    expect(labels[3]).toBe(headers[3])
    expect(labels[4]).toBe(headers[4])
    // ...and those words are non-empty, so the assertions above can't pass by
    // both sides being blank.
    expect(labels.slice(2).every((l) => (l?.length ?? 0) > 0)).toBe(true)

    // Seed + player are the card's caption and headline — they carry no stat
    // label (the CSS gives them their own treatment via `.id-cell` /
    // `data-cell="players"`).
    expect(labels[0]).toBeNull()
    expect(labels[1]).toBeNull()
    expect(row.querySelectorAll('td')[0].classList).toContain('id-cell')
    expect(row.querySelectorAll('td')[1].dataset.cell).toBe('players')
  })

  it('does not crash when the roster is empty', async () => {
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players', () =>
        HttpResponse.json({ items: [], page: 1, page_size: 25, total: 0 }),
      ),
    )

    renderRoster('/players')

    await waitFor(() =>
      expect(screen.getByText(/no players match/i)).toBeInTheDocument(),
    )
  })
})
