import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  renderHook as renderHookRaw,
  waitFor as waitForRaw,
} from '@testing-library/react'
import { HttpResponse } from 'msw'
import { toast } from 'sonner'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderHook, waitFor } from '@/test/utilities'
import {
  mockEventEnterEndpoint,
  mockEventWithdrawEndpoint,
  mockTournamentCreateEndpoint,
  mockTournamentDetailEndpoint,
  mockTournamentUpdateEndpoint,
  mockTournamentsListEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import {
  buildTournamentDetailRead,
  buildTournamentEntrantRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { resetTournamentsStore } from '@/mocks/tournaments-store'
import type { components } from '@/api/schema'
import {
  useCreateTournament,
  useEnterEvent,
  useTournament,
  useTournaments,
  useUpdateTournament,
  useWithdrawEntry,
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

describe('useEnterEvent', () => {
  it('posts to the event entries route with NO body — the caller is the entrant', async () => {
    let seen: { url: string; body: string } | null = null
    mockEventEnterEndpoint(server, async ({ request }) => {
      seen = { url: request.url, body: await request.text() }
      return HttpResponse.json(
        buildTournamentEntrantRead({
          id: 'entry-9',
          user_id: 'u-me',
          username: 'rita.kovac',
        }),
        { status: 201 },
      )
    })

    const { result } = renderHook(() => useEnterEvent('t-1'))
    const entrant = await result.current.mutateAsync('ev-1')

    // The ENTRY id — the address a withdrawal is later sent to.
    expect(entrant).toEqual({
      id: 'entry-9',
      userId: 'u-me',
      username: 'rita.kovac',
      seed: null,
    })
    expect(seen!.url).toContain('/v1/tournaments/t-1/events/ev-1/entries')
    expect(seen!.body).toBe('')
  })

  it('invalidates the list and the detail so the count and the entrants both refresh', async () => {
    mockEventEnterEndpoint(server, () =>
      HttpResponse.json(buildTournamentEntrantRead(), { status: 201 }),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
  })

  it('surfaces a duplicate-entry 409 via a toast without throwing', async () => {
    vi.mocked(toast.error).mockClear()
    mockEventEnterEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'You have already entered this event.' },
        { status: 409 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't enter the event",
      expect.objectContaining({
        description: 'You have already entered this event.',
      }),
    )
  })
})

describe('useWithdrawEntry', () => {
  it('deletes the ENTRY (not the event) and resolves on the bodiless 204', async () => {
    let seenUrl = ''
    mockEventWithdrawEndpoint(server, ({ request }) => {
      seenUrl = request.url
      return new HttpResponse(null, { status: 204 })
    })
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useWithdrawEntry('t-1'), { wrapper })
    result.current.mutate({ eventId: 'ev-1', entryId: 'entry-9' })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(seenUrl).toContain(
      '/v1/tournaments/t-1/events/ev-1/entries/entry-9',
    )
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
  })

  it("surfaces a 403 (someone else's entry) via a toast", async () => {
    vi.mocked(toast.error).mockClear()
    mockEventWithdrawEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'You can only withdraw your own entry.' },
        { status: 403 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useWithdrawEntry('t-1'), { wrapper })
    result.current.mutate({ eventId: 'ev-1', entryId: 'entry-other' })

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't withdraw from the event",
      expect.objectContaining({
        description: 'You can only withdraw your own entry.',
      }),
    )
  })
})

// The round trip, driven through the DEFAULT handlers and the dev store rather
// than a per-test stub: entering has to make the *next read* of that event show
// the entrant AND an incremented count — a store that updated the list but not
// the count (or vice versa) is exactly the drift the derived count exists to
// make impossible.
describe('entering and withdrawing, against the stateful mock store', () => {
  beforeEach(() => resetTournamentsStore())

  const TOURNAMENT = 'bay-area-open-2026'
  const EVENT = 'ev-u1500' // seeded with nobody in it

  it('adds the entrant and increments the count; withdrawing reverses both', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(
      () => ({
        detail: useTournament(TOURNAMENT),
        enter: useEnterEvent(TOURNAMENT),
        withdraw: useWithdrawEntry(TOURNAMENT),
      }),
      { wrapper },
    )
    const event = () =>
      result.current.detail.data!.events.find((e) => e.id === EVENT)!

    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())
    expect(event().entered).toBe(0)
    expect(event().entrants).toEqual([])

    const entrant = await act(() => result.current.enter.mutateAsync(EVENT))

    await waitForRaw(() => expect(event().entered).toBe(1))
    expect(event().entrants.map((e) => e.username)).toEqual(['rita.kovac'])
    expect(event().entrants[0].id).toBe(entrant.id)

    await act(() =>
      result.current.withdraw.mutateAsync({
        eventId: EVENT,
        entryId: entrant.id,
      }),
    )

    await waitForRaw(() => expect(event().entered).toBe(0))
    expect(event().entrants).toEqual([])
  })

  it('lets a withdrawn player enter the same event again — withdrawal is not a lockout', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(
      () => ({
        detail: useTournament(TOURNAMENT),
        enter: useEnterEvent(TOURNAMENT),
        withdraw: useWithdrawEntry(TOURNAMENT),
      }),
      { wrapper },
    )
    const event = () =>
      result.current.detail.data!.events.find((e) => e.id === EVENT)!

    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())

    const first = await act(() => result.current.enter.mutateAsync(EVENT))
    await act(() =>
      result.current.withdraw.mutateAsync({
        eventId: EVENT,
        entryId: first.id,
      }),
    )
    await act(() => result.current.enter.mutateAsync(EVENT))

    await waitForRaw(() => expect(event().entered).toBe(1))
    expect(event().entrants.map((e) => e.username)).toEqual(['rita.kovac'])
  })
})
