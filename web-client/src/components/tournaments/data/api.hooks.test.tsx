import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  renderHook as renderHookRaw,
  waitFor as waitForRaw,
} from '@testing-library/react'
import { HttpResponse } from 'msw'
import { toast } from 'sonner'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderHook, waitFor } from '@/test/utilities'
import {
  mockTournamentCreateEndpoint,
  mockTournamentDetailEndpoint,
  mockTournamentUpdateEndpoint,
  mockTournamentsListEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import type { components } from '@/api/schema'
import {
  useCreateTournament,
  useTournament,
  useTournaments,
  useUpdateTournament,
} from './api'

type TournamentUpdate = components['schemas']['TournamentUpdate']

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } }
})

describe('useTournaments', () => {
  it('maps the API list to prototype tournaments', async () => {
    mockTournamentsListEndpoint(server, () =>
      HttpResponse.json([
        buildTournamentDetailRead({ id: 't-1', name: 'Bay Area Open 2026' }),
      ]),
    )

    const { result } = renderHook(() => useTournaments())

    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0]).toMatchObject({
      id: 't-1',
      name: 'Bay Area Open 2026',
      tableIds: ['t1', 't2', 't3', 't4'],
    })
  })
})

describe('useTournament', () => {
  it('resolves the mapped tournament for a known id', async () => {
    mockTournamentDetailEndpoint(server, () =>
      HttpResponse.json(buildTournamentDetailRead({ id: 't-1' })),
    )

    const { result } = renderHook(() => useTournament('t-1'))

    await waitFor(() => expect(result.current.data).not.toBeUndefined())
    expect(result.current.data).toMatchObject({ id: 't-1' })
  })

  it('resolves to null (not an error) when the id 404s', async () => {
    mockTournamentDetailEndpoint(server, () =>
      HttpResponse.json({ detail: 'Tournament not found.' }, { status: 404 }),
    )

    const { result } = renderHook(() => useTournament('missing'))

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
    expect(result.current.isError).toBe(false)
  })
})

describe('useCreateTournament', () => {
  it('returns the created tournament so the caller can navigate to its id', async () => {
    mockTournamentCreateEndpoint(server, () =>
      HttpResponse.json(
        // The create endpoint returns a bare TournamentRead (no events).
        (() => {
          const { events, ...read } = buildTournamentDetailRead({
            id: 't-new',
            name: 'Autumn Cup',
          })
          void events
          return read
        })(),
        { status: 201 },
      ),
    )

    const { result } = renderHook(() => useCreateTournament())

    const created = await result.current.mutateAsync({
      name: 'Autumn Cup',
      status: 'draft',
      address: {
        venue: 'Oakland Arena',
        street: '7000 Coliseum Way',
        city: 'Oakland',
        region: 'CA',
        postal: '94621',
        country: 'USA',
      },
    })

    expect(created.id).toBe('t-new')
  })
})

// These cases need their own QueryClient so they can spy on its
// `invalidateQueries`; the shared `renderHook` wrapper hides the client.
function setupClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { invalidateSpy, wrapper }
}

const updatePatch: TournamentUpdate = {
  name: 'Renamed Open',
  description: 'Updated.',
  status: 'published',
  start_date: '2026-06-13',
  end_date: '2026-06-14',
  address: {
    venue: 'Berkeley TT Club',
    street: '2727 Milvia St',
    city: 'Berkeley',
    region: 'CA',
    postal: '94703',
    country: 'USA',
  },
  table_catalogue: [],
}

describe('useUpdateTournament', () => {
  it('invalidates the list and detail queries on success', async () => {
    mockTournamentUpdateEndpoint(server, () =>
      HttpResponse.json(
        // The update endpoint returns a bare TournamentRead (no events).
        (() => {
          const { events, ...read } = buildTournamentDetailRead({
            id: 't-1',
            name: 'Renamed Open',
          })
          void events
          return read
        })(),
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUpdateTournament(), { wrapper })
    result.current.mutate({ id: 't-1', patch: updatePatch })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tournaments', 't-1'],
    })
  })

  it('surfaces a 403 via a toast without throwing', async () => {
    vi.mocked(toast.error).mockClear()
    mockTournamentUpdateEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'You do not have permission to edit this tournament.' },
        { status: 403 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUpdateTournament(), { wrapper })
    result.current.mutate({ id: 't-1', patch: updatePatch })

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't update the tournament",
      expect.objectContaining({
        description: 'You do not have permission to edit this tournament.',
      }),
    )
  })
})
