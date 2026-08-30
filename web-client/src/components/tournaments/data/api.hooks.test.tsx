import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isNotFound } from '@tanstack/react-router'
import {
  act,
  render,
  renderHook as renderHookRaw,
  screen,
  waitFor as waitForRaw,
} from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { StrictResponse } from 'msw'
import { toast } from 'sonner'
import { Component, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderHook, waitFor } from '@/test/utilities'
import {
  mockEventCutDrawEndpoint,
  mockScheduleSolveEndpoint,
  mockEventEnterEndpoint,
  mockFixturePlacementEndpoint,
  mockEventUncutDrawEndpoint,
  mockEventWithdrawEndpoint,
  mockTournamentCreateEndpoint,
  mockTournamentDetailEndpoint,
  mockTournamentTransitionEndpoint,
  mockTournamentUpdateEndpoint,
  mockTournamentsListEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import {
  buildScheduleSolveRead,
  buildTournamentDetailRead,
  buildTournamentEntrantRead,
  buildTournamentEventRead,
  buildTournamentFixtureRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import type { CodedErrorBody } from '@/mocks/endpoints/error-body'
import { mockUuid } from '@/mocks/mock-uuid'
import {
  BAY_AREA_OPEN_ID,
  SUMMER_SLAM_ID,
} from '@/mocks/factories/tournaments/tournament-ids'
import { server } from '@/mocks/server'
import {
  cutDraw,
  findTournament,
  markFixturePlayed,
  resetTournamentsStore,
} from '@/mocks/tournaments-store'
import { ApiError, validationFields } from '@/api/client'
import type { components } from '@/api/schema'
import { addedReservation, keepReservations } from './reservation-entries'
import { buildEditedEvent, buildTenReservations } from './seed.factory'
import {
  apiToEvent,
  eventToUpdateBody,
  useCreateTournament,
  useCutDraw,
  useEnterEvent,
  usePlaceFixture,
  useRequestScheduleSolve,
  useTournament,
  useTournaments,
  useTransitionTournament,
  useUncutDraw,
  useUpdateEvent,
  useUpdateTournament,
  useWithdrawEntry,
} from './api'
import { LIFECYCLE_EDGE, type LifecycleEdge } from './lifecycle'

type TournamentUpdate = components['schemas']['TournamentUpdate']
type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']

/** The edge OUT of `from` — which is what the transition mutation takes: an edge,
 * not a bare target status. It carries both the `to` for the body and the verb the
 * failure toast names the click with, and those are two facts about one edge (there
 * is exactly one lifecycle table). This is also how a real caller gets one: the
 * header renders the edge its tournament's status offers. */
function edgeFrom(from: 'draft' | 'published' | 'live'): LifecycleEdge {
  const edge = LIFECYCLE_EDGE[from]
  if (!edge) throw new Error(`no edge out of ${from}`)
  return edge
}

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return {
    ...actual,
    toast: { ...actual.toast, error: vi.fn(), info: vi.fn(), success: vi.fn() },
  }
})

/** Every toast channel starts clean: the entry cases assert not just which toast
 * fired, but that the *others* did not (a benign 409 that also raised a red error
 * toast would satisfy a one-sided assertion) — and the lifecycle cases assert that
 * NONE of them fired at all, since that mutation reports through its caller now. */
beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.info).mockClear()
  vi.mocked(toast.success).mockClear()
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

  // The near-me filter (chore 3a): a location + radius goes on the wire as the API's
  // all-or-nothing `lat`/`lng`/`radius_miles` triple, and each row's server-computed
  // `distance_miles` is parsed onto `distanceMiles`.
  it('sends lat/lng/radius_miles and surfaces the parsed distanceMiles when given a location', async () => {
    let seenUrl = ''
    mockTournamentsListEndpoint(server, ({ request }) => {
      seenUrl = request.url
      return HttpResponse.json([
        buildTournamentDetailRead({
          id: 't-1',
          name: 'Bay Area Open 2026',
          distance_miles: 4.2,
        }),
      ])
    })

    const { result } = renderHook(() =>
      useTournaments({ lat: 37.7749, lng: -122.4194, radiusMiles: 25 }),
    )

    await waitFor(() => expect(result.current).toHaveLength(1))

    const params = new URL(seenUrl).searchParams
    expect(params.get('lat')).toBe('37.7749')
    expect(params.get('lng')).toBe('-122.4194')
    expect(params.get('radius_miles')).toBe('25')
    // The server-computed haversine distance, parsed at the boundary (`./api`).
    expect(result.current[0].distanceMiles).toBe(4.2)
  })

  // Absent a location the request is EXACTLY the default list — no query params at all —
  // and every row's `distanceMiles` is the designed `null` (the server sent none).
  it('sends no query params for the default list, and surfaces distanceMiles null', async () => {
    let seenUrl = ''
    mockTournamentsListEndpoint(server, ({ request }) => {
      seenUrl = request.url
      return HttpResponse.json([buildTournamentDetailRead({ id: 't-1' })])
    })

    const { result } = renderHook(() => useTournaments())

    await waitFor(() => expect(result.current).toHaveLength(1))

    // No `?lat=…&lng=…&radius_miles=…` — the default list is unchanged.
    expect(new URL(seenUrl).search).toBe('')
    expect(result.current[0].distanceMiles).toBeNull()
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

  it('converts a 404 into a router notFound() — never a null, and never an ApiError (ADR-1001)', async () => {
    // A missing tournament is a designed state, not an error value: the `queryFn`
    // throws a router `notFound()`, which `throwOnError` re-throws to a boundary
    // (the route's `notFoundComponent` in production). So it is the plain
    // `{ isNotFound: true }` object, NOT an `ApiError`, and emphatically not the
    // `null` the route used to have to model as "missing". A capturing boundary
    // reads back what was actually thrown.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockTournamentDetailEndpoint(server, () =>
      HttpResponse.json({ detail: 'Tournament not found.' }, { status: 404 }),
    )

    let caught: unknown
    function Page() {
      useTournament('missing')
      return <p>loaded</p>
    }
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CaptureBoundary onCatch={(e) => (caught = e)}>
          <Page />
        </CaptureBoundary>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(caught).toBeDefined())
    expect(isNotFound(caught)).toBe(true)
    expect(caught).not.toBeInstanceOf(ApiError)
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

    // No `status`: `TournamentCreate` has no such field (ADR-0017) — the server
    // makes it a draft.
    const created = await result.current.mutateAsync({
      name: 'Autumn Cup',
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

// A tournament-level edit, exactly as `tournamentToUpdateBody` builds it: no
// `status` — the patch schema has no such field (ADR-0017), and the lifecycle
// moves only through `POST /v1/tournaments/{id}/transitions`.
const updatePatch: TournamentUpdate = {
  name: 'Renamed Open',
  description: 'Updated.',
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

  it('emits no toast on failure — the Details form owns the refusal inline (#1593)', async () => {
    vi.mocked(toast.error).mockClear()
    mockTournamentUpdateEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'You do not have permission to edit this tournament.' },
        { status: 403 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUpdateTournament(), { wrapper })
    // The Details tab's own shape — `mutateAsync`, so the rejection is
    // catchable there — and the error stays the form's to word.
    await expect(
      result.current.mutateAsync({ id: 't-1', patch: updatePatch }),
    ).rejects.toThrow()

    await waitForRaw(() => expect(result.current.isError).toBe(true))
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })
})

/**
 * **The bytes that leave the client** (ADR 20260727).
 *
 * Every other test of the qualifier count stops at a mapper's return value or at a spy's
 * argument. This one intercepts the real `PATCH` at the fetch boundary and reads the body
 * off the `Request` — the only assertion in the suite that cannot pass while the field is
 * dropped somewhere between `eventToUpdateBody` and `openapi-fetch`, and the closest
 * vitest can get to the e2e suite's `page.route` (which runs with MSW off and would not
 * catch a mismatch here either way round).
 */
describe('useUpdateEvent — the draw configuration on the wire', () => {
  /** Capture the next event PATCH's decoded body. */
  function captureEventPatch() {
    const sent: { body?: Record<string, unknown> } = {}
    server.use(
      http.patch(
        '*/v1/tournaments/:tournamentId/events/:eventId',
        async ({ request }) => {
          sent.body = (await request.json()) as Record<string, unknown>
          return HttpResponse.json(
            buildTournamentEventRead({
              draw_type: 'rr-then-ko',
              qualifiers_per_group: 2,
            }),
          )
        },
      ),
    )
    return sent
  }

  it('puts the configured qualifier count in the PATCH body', async () => {
    const sent = captureEventPatch()
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUpdateEvent('t-1'), { wrapper })
    result.current.mutate({
      eventId: 'ev-1',
      body: eventToUpdateBody(
        buildEditedEvent({ drawType: 'rr-then-ko', qualifiersPerGroup: 2 }),
      ),
    })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))
    expect(sent.body).toMatchObject({
      draw_type: 'rr-then-ko',
      qualifiers_per_group: 2,
    })
  })

  // …and the negative half, which is the one that would 422: the other two arms of the
  // server's draw-settings union declare no such field and are `extra="forbid"`, so the
  // key must be ABSENT from the JSON — not present and null.
  it('sends no such key at all for a draw type with no knockout stage', async () => {
    const sent = captureEventPatch()
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUpdateEvent('t-1'), { wrapper })
    result.current.mutate({
      eventId: 'ev-1',
      body: eventToUpdateBody(buildEditedEvent({ drawType: 'round-robin' })),
    })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))
    expect(sent.body).toHaveProperty('draw_type', 'round-robin')
    expect(sent.body && 'qualifiers_per_group' in sent.body).toBe(false)
  })

  // The round trip, across the real decode: what the handler answered comes back through
  // `apiToEvent` as the domain's `qualifiersPerGroup`.
  it('reads the stored count back off the response', async () => {
    captureEventPatch()
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUpdateEvent('t-1'), { wrapper })
    result.current.mutate({
      eventId: 'ev-1',
      body: eventToUpdateBody(
        buildEditedEvent({ drawType: 'rr-then-ko', qualifiersPerGroup: 2 }),
      ),
    })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))
    expect(apiToEvent(result.current.data!).qualifiersPerGroup).toBe(2)
  })

  /**
   * **A reservation's `position` must not leave the client.** It is the server's to
   * assign — from the index of the reservation in this very array — and
   * `ReservationWrite` is `extra="forbid"`, so a `position` key here is a 422 naming the
   * field and the director's whole save is refused.
   *
   * Asserted on the bytes rather than on `eventToUpdateBody`'s return value for the same
   * reason the qualifier count is: the `Reservation` these entries were built from *does*
   * carry a position, so a spread anywhere between the mapper and `openapi-fetch` would
   * put it back, and nothing else in the suite would notice.
   */
  it('sends each reservation WITHOUT a position — the server assigns it from the order', async () => {
    const sent = captureEventPatch()
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUpdateEvent('t-1'), { wrapper })
    result.current.mutate({
      eventId: 'ev-1',
      // Ten reservations, so a dropped position could not hide behind a single `0`.
      body: eventToUpdateBody(
        buildEditedEvent({ reservations: keepReservations(buildTenReservations()) }),
      ),
    })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))
    const reservations = sent.body?.reservations as Record<string, unknown>[]
    expect(reservations).toHaveLength(10)
    for (const reservation of reservations) {
      expect(Object.keys(reservation).sort()).toEqual([
        'id',
        'name',
        'slot',
        'table_ids',
      ])
    }
  })
})

/**
 * **A reservation's id, round trip** (ADR 20260801) — the client's write judged by the
 * store that stands in for the server, rather than by an assertion about itself.
 *
 * This is the one claim of the chore that no mapper test can make: the mock applies the
 * same id-keyed diff the route does (`applyEventReservations`, `mocks/tournaments-store`),
 * so a body that minted its own reservation id is a **422 naming that entry** here
 * exactly as it is in production — while every assertion about `eventToUpdateBody`'s
 * return value would go on passing. The seeded tournament is used rather than a stubbed
 * handler for that very reason: a stub would answer whatever it was told to.
 */
describe('an added reservation, through the mock’s id-keyed diff', () => {
  // The seed's owned, published tournament and its event.
  const TOURNAMENT = BAY_AREA_OPEN_ID
  const EVENT = mockUuid('ev-open-singles')

  beforeEach(() => resetTournamentsStore())

  it('sends no id and reads the server’s minted uuid back', async () => {
    const { wrapper } = setupClient()
    const stored = apiToEvent(findTournament(TOURNAMENT)!.events[0])
    expect(stored.id).toBe(EVENT)

    const { result } = renderHookRaw(() => useUpdateEvent(TOURNAMENT), { wrapper })
    result.current.mutate({
      eventId: EVENT,
      body: eventToUpdateBody({
        ...stored,
        // rr-then-ko (#1482): this PATCH leaves the event holding TWO reservations —
        // one kept, one added — which every other draw type now caps at one.
        drawType: 'rr-then-ko',
        qualifiersPerGroup: 2,
        reservations: [
          ...keepReservations(stored.reservations),
          addedReservation({
            name: 'Reservation Z',
            slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
            tableIds: ['t7'],
          }),
        ],
      }),
    })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))
    const saved = apiToEvent(result.current.data!)
    // The reservation it already had kept its id — which is what keeps the group (and
    // therefore the fixtures) mapped to it — and the new one came back with an id this
    // client never authored.
    expect(saved.reservations.map((r) => r.id).slice(0, 1)).toEqual(
      stored.reservations.map((r) => r.id),
    )
    const added = saved.reservations[1]
    expect(added.name).toBe('Reservation Z')
    expect(added.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    // …and the server, not the array, decided where it sits.
    expect(saved.reservations.map((r) => r.position)).toEqual([0, 1])
  })

  /** The other half of the diff, and the reason a client may never mint: an id the event
   * does not hold is refused ON THAT ENTRY (`['body','reservations',i,'id']`) rather than
   * quietly minted — which would hand back a different id than was asked for while
   * removing the reservation the director meant to keep. */
  it('refuses a body that cites an id this event does not have', async () => {
    const { wrapper } = setupClient()
    const stored = apiToEvent(findTournament(TOURNAMENT)!.events[0])

    const { result } = renderHookRaw(() => useUpdateEvent(TOURNAMENT), { wrapper })
    result.current.mutate({
      eventId: EVENT,
      body: eventToUpdateBody({
        ...stored,
        reservations: keepReservations([
          { ...stored.reservations[0], id: 'res-invented' },
        ]),
      }),
    })

    await waitForRaw(() => expect(result.current.isError).toBe(true))
    const error = result.current.error as ApiError
    expect(error.status).toBe(422)
    // A per-field Pydantic body, not a sentence — so `saveFailure` classifies it as
    // `invalid` and the editor says so in its own words rather than reading a
    // validator's prose out to the director. The entry's index is in the `loc`
    // (`['body','reservations',0,'id']`), which is what a surface would blame the card by.
    expect(validationFields(error)).toEqual(['reservations'])
  })
})

describe('useTransitionTournament', () => {
  /** The moved tournament, as the API answers a 201: a bare `TournamentRead`. */
  function movedTo(status: 'published' | 'live' | 'archived') {
    const { events, ...read } = buildTournamentDetailRead({ id: 't-1', status })
    void events
    return read
  }

  it('posts { to } to the transitions resource — never a status-carrying PATCH', async () => {
    let seen: { url: string; body: unknown } | null = null
    mockTournamentTransitionEndpoint(server, async ({ request }) => {
      seen = { url: request.url, body: await request.json() }
      return HttpResponse.json(movedTo('published'), { status: 201 })
    })

    const { result } = renderHook(() => useTransitionTournament('t-1'))
    const moved = await result.current.mutateAsync(edgeFrom('draft'))

    expect(seen!.url).toContain('/v1/tournaments/t-1/transitions')
    // `to` alone on the WIRE — the mutation takes the whole edge, but only its
    // target is sent: the tournament already knows where it *is*, and a stale
    // client that also sent `from` would only be reporting what it believed
    // (ADR-0017).
    expect(seen!.body).toEqual({ to: 'published' })
    expect(moved.status).toBe('published')
  })

  it('invalidates the list and the detail — the list cards render the status pill too', async () => {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json(movedTo('live'), { status: 201 }),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useTransitionTournament('t-1'), {
      wrapper,
    })
    result.current.mutate(edgeFrom('published'))

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tournaments', 't-1'],
    })
  })

  // The stale-tab race (ADR-0017's reason for 409-ing a re-assertion): tab A
  // published; THIS tab still reads `draft`, so it still offers Publish. The
  // refusal has to be VISIBLE — a swallowed 409 is a button that does nothing —
  // but this mutation is not the thing that shows it. It **hands the error to its
  // caller**, whole, and stays quiet: `LifecycleActions` renders every refusal inline,
  // beside the button, so a toast here would say the same thing twice
  // (`web-client/CLAUDE.md`, ## Forms: never both). The 409 that matters most is
  // go-live's precondition (ADR-0786), whose sentence *names the events* the director
  // has to go and fix — a work list belongs on the page, not in a four-second toast.
  it('hands the 409 to its caller — with the server’s sentence — and does NOT toast', async () => {
    // The server sees `published → published` — a self-transition — so it answers
    // the sentence that says what happened, not the tautology naming both ends.
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'This tournament is already published.' },
        { status: 409 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useTransitionTournament('t-1'), {
      wrapper,
    })
    // The edge this stale tab is still offering: it reads `draft`, so it offers
    // Publish — which the server has already been published out from under.
    result.current.mutate(edgeFrom('draft'))

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    // The error the component catches: the status it branches on, and the sentence it
    // shows. Both survive the trip — nothing is flattened into a message string.
    const error = result.current.error
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).detail).toBe('This tournament is already published.')

    // Silence on every ring of the toaster, not just the error one: a refusal
    // announced as a cheerful `toast.success` would still be a double-up.
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('invalidates on the 409 too, so the stale view catches up to the status it was refused', async () => {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'This tournament is already published.' },
        { status: 409 },
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useTransitionTournament('t-1'), {
      wrapper,
    })
    result.current.mutate(edgeFrom('draft'))

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    // Without this, the tab keeps offering Publish on a tournament the server has
    // just told it is already published — the same freeze #943 found on entries.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tournaments', 't-1'],
    })
  })

  // A 5xx is not a refusal, and it is still not a toast: the same caller reports it, in
  // its own words (`lifecycleRefusalNotice`'s `server-error` arm — which deliberately
  // does NOT repeat the server's detail, since a 5xx detail is machinery). What this
  // mutation owes the caller is the status; what it owes the user is nothing.
  it('stays quiet on a 5xx too — the error is the caller’s to report', async () => {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json({ detail: 'Server error.' }, { status: 500 }),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useTransitionTournament('t-1'), {
      wrapper,
    })
    // The edge out of `live` — "End tournament".
    result.current.mutate(edgeFrom('live'))

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect((result.current.error as ApiError).status).toBe(500)
    expect(toast.error).not.toHaveBeenCalled()
  })
})

// The lifecycle end to end through the stateful dev store, which enforces the
// SAME edge table as the server: a mock that let an illegal edge through would
// let a broken UI look fine in dev and in vitest alike.
describe('the lifecycle, against the stateful mock store', () => {
  beforeEach(() => resetTournamentsStore())

  const DRAFT = SUMMER_SLAM_ID // seeded `draft`, owned by the dev user

  it('walks draft → published → live → archived, and the detail reads back each move', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(
      () => ({
        detail: useTournament(DRAFT),
        move: useTransitionTournament(DRAFT),
      }),
      { wrapper },
    )

    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())
    expect(result.current.detail.data!.status).toBe('draft')

    // Each step takes the edge the status it is standing on offers — which is
    // exactly what the header hands the mutation.
    await act(() => result.current.move.mutateAsync(edgeFrom('draft')))
    await waitForRaw(() =>
      expect(result.current.detail.data!.status).toBe('published'),
    )

    await act(() => result.current.move.mutateAsync(edgeFrom('published')))
    await waitForRaw(() => expect(result.current.detail.data!.status).toBe('live'))

    await act(() => result.current.move.mutateAsync(edgeFrom('live')))
    await waitForRaw(() =>
      expect(result.current.detail.data!.status).toBe('archived'),
    )
  })

  it('refuses to skip a stage — draft → live is a 409, and the status does not move', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(
      () => ({
        detail: useTournament(DRAFT),
        move: useTransitionTournament(DRAFT),
      }),
      { wrapper },
    )

    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())

    // The published→live edge, posted at a tournament that is still a DRAFT: a
    // stale tab holding the edge it last saw. `to: 'live'` from `draft` skips a
    // stage, and the server refuses it.
    result.current.move.mutate(edgeFrom('published'))
    await waitForRaw(() => expect(result.current.move.isError).toBe(true))

    expect((result.current.move.error as ApiError).status).toBe(409)
    await waitForRaw(() => expect(result.current.detail.data!.status).toBe('draft'))
  })
})

/** A refused entry, in the shape the route really answers with (ADR-0968): a 409
 * whose `detail` is `{code, message}`. The **code** is what the client reads, so
 * the `message` defaults to prose no test asserts on — a stub that mattered only
 * for its sentence would be re-creating the byte-matching this chore deleted. */
function refused(
  code: string,
  message = 'the server said something',
): StrictResponse<CodedErrorBody> {
  return HttpResponse.json({ detail: { code, message } }, { status: 409 })
}

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
      // The rating the server resolved on the tournament's ladder (ADR-0783) — the
      // factory's rated default; `null` here would mean the entrant is unrated.
      rating: 1450,
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

  // The stale-tab race, at the level the bug lives: a 409 means the server and
  // this screen disagree, so the *failed* mutation has to re-read the server too.
  // Invalidating only `onSuccess` left the card frozen on the pre-click render it
  // had just been proven wrong about.
  it('invalidates on FAILURE too, so a 409 reconciles the view instead of freezing it', async () => {
    mockEventEnterEndpoint(server, () => refused('already_entered'))
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
  })

  it('treats a duplicate-entry 409 as benign: an informational note, not a red error', async () => {
    mockEventEnterEndpoint(server, () => refused('already_entered'))
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    // `already_entered` is not a failure the player caused or can fix — they ARE
    // entered, and the reconciled card now says so. An error toast on top of a
    // screen that reads "Withdraw" would contradict it.
    expect(toast.info).toHaveBeenCalledWith(
      'You were already entered in this event',
      expect.objectContaining({
        description: "We've refreshed it with the latest entries.",
      }),
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  // The OTHER 409 (ADR-0017), and the reason a bare `status === 409` check is not
  // enough: `POST …/entries` refuses a CLOSED REGISTRATION WINDOW with a 409 too.
  // The stale tab is the director's fault, not the player's — they had the page
  // open, the director started the tournament from another tab, and the Enter
  // button they are looking at is now a button the server refuses.
  //
  // Telling them "You were already entered in this event" there is FALSE: they are
  // not entered, they cannot enter, and the card is about to say so.
  //
  // **The three rows are three different MESSAGES behind the SAME code** — the
  // server says something different about a `draft` tournament than about an
  // `archived` one, and the third row is prose it has never actually sent. All
  // three must produce the same client copy: that is what "the client switches on
  // the code and owns its copy" means, and it is the property the old
  // byte-for-byte `error.detail === 'You have already entered this event.'` did
  // not have. Reword the server, and nothing here moves (ADR-0968).
  it.each([
    {
      status: 'live',
      message: 'This tournament is already under way, so its entries are locked.',
    },
    {
      status: 'draft',
      message:
        'This tournament has not been published yet, so its events are not open for entry.',
    },
    {
      status: 'reworded overnight',
      message: 'Nope! Registration shut. 🙅 (a sentence nobody planned for)',
    },
  ])(
    'reads a closed-window 409 off its CODE, whatever the server says ($status)',
    async ({ message }) => {
      mockEventEnterEndpoint(server, () =>
        refused('registration_closed', message),
      )
      const { wrapper } = setupClient()

      const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
      result.current.mutate('ev-1')

      await waitForRaw(() => expect(result.current.isError).toBe(true))

      // The client's copy, both lines of it — identical for all three rows, and
      // the server's sentence appears in NONE of them ("Raw API detail strings
      // never reach the UI", DEFINITION_OF_COMPLETE.md).
      expect(toast.error).toHaveBeenCalledWith(
        'Entries are closed for this event',
        expect.objectContaining({
          description:
            "This tournament's registration window is shut. We've refreshed it with the latest status.",
        }),
      )
      // THE assertion. The benign note is for `already_entered` alone; firing it
      // here would tell a player who is NOT entered that they are — over a card
      // that (once the settle-reconcile lands) shows the lock.
      expect(toast.info).not.toHaveBeenCalled()
    },
  )

  // #783's two refusals, now that this client HAS copy for them: the code decides,
  // and the words are ours — the server's `message` never reaches the toast.
  it.each([
    {
      code: 'event_full',
      message: 'This event is full.',
      title: 'Event full',
      description: 'Every place in this event has been taken.',
    },
    {
      code: 'rating_ineligible',
      message: 'Your rating does not meet this event’s eligibility rules.',
      title: 'Not eligible',
      description: "Your rating doesn't meet this event's eligibility rules.",
    },
  ])('words the $code refusal itself, not out of the server\'s message', async ({
    code,
    message,
    title,
    description,
  }) => {
    mockEventEnterEndpoint(server, () =>
      HttpResponse.json({ detail: { code, message } }, { status: 409 }),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      title,
      expect.objectContaining({ description }),
    )
    // The bug ADR-0968 was written against: the old `entryConflict` fell through to
    // "registration closed" for ANY 409 it did not recognise, so a player refused
    // from a FULL event on a PUBLISHED tournament was told the window was shut — a
    // headline contradicting the sentence printed under it.
    expect(toast.error).not.toHaveBeenCalledWith(
      'Entries are closed for this event',
      expect.anything(),
    )
    expect(toast.info).not.toHaveBeenCalled()
  })

  // The honest degrade for a code that is NOT in the table — #784's refusals, an
  // older server, a code we have not shipped copy for yet: no invented headline,
  // and the server's own words rather than one of ours that would be a lie.
  it('degrades to the server\'s words for a code it does not know — it does NOT guess "closed"', async () => {
    mockEventEnterEndpoint(server, () =>
      HttpResponse.json(
        {
          detail: {
            code: 'invitation_only',
            message: 'This event is invitation-only.',
          },
        },
        { status: 409 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't enter the event",
      expect.objectContaining({ description: 'This event is invitation-only.' }),
    )
    // None of the four copies this client owns is a truthful thing to say here.
    expect(toast.error).not.toHaveBeenCalledWith(
      'Entries are closed for this event',
      expect.anything(),
    )
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('still surfaces a GENUINE failure (a 400, a 5xx) as an error toast', async () => {
    // The benign-409 carve-out must not become a swallow-everything: a doubles
    // 400, and anything 5xx, are real errors and still shout.
    mockEventEnterEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'Only singles events can be entered directly, not doubles.' },
        { status: 400 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-doubles')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't enter the event",
      expect.objectContaining({
        description:
          'Only singles events can be entered directly, not doubles.',
      }),
    )
    expect(toast.info).not.toHaveBeenCalled()
  })
})

// The QA repro (#943), end to end through the cache: two tabs, one player. Tab B
// entered; THIS tab still holds the read from before that, so it renders `0 / 64`
// and an Enter button. Clicking Enter 409s — and the card must come back TRUE
// (1 entrant, me), not stay frozen on the render the 409 just disproved.
describe('entering from a STALE view (the two-tab race)', () => {
  const ME = buildTournamentEntrantRead({
    id: 'entry-9',
    user_id: 'u-me',
    username: 'rita.kovac',
  })

  /** The tournament detail as this tab reads it: the FIRST read is the stale one
   * (taken before tab B entered me); every read after it tells the truth. */
  function mockDetailStaleThenTrue() {
    let reads = 0
    mockTournamentDetailEndpoint(server, () => {
      const stale = reads === 0
      reads += 1
      return HttpResponse.json(
        buildTournamentDetailRead({
          id: 't-1',
          events: [
            buildTournamentEventRead({
              id: 'ev-1',
              entrants: stale ? [] : [ME],
            }),
          ],
        }),
      )
    })
  }

  it('re-reads the tournament on the 409 — the count, the roster and the control all catch up', async () => {
    mockDetailStaleThenTrue()
    // The server is right and the screen is wrong: this player is already in.
    mockEventEnterEndpoint(server, () => refused('already_entered'))
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(
      () => ({ detail: useTournament('t-1'), enter: useEnterEvent('t-1') }),
      { wrapper },
    )
    const event = () => result.current.detail.data!.events[0]

    // The stale render the QA pass saw: nobody entered, so the card offers Enter.
    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())
    expect(event().entered).toBe(0)
    expect(event().entrants).toEqual([])

    result.current.enter.mutate('ev-1')
    await waitForRaw(() => expect(result.current.enter.isError).toBe(true))

    // THE assertion. Before the fix this stays `0` forever — the mutation failed,
    // nothing invalidated, and only a manual reload revealed the truth.
    await waitForRaw(() => expect(event().entered).toBe(1))
    expect(event().entrants.map((e) => e.username)).toEqual(['rita.kovac'])
    // …which is what flips the control to Withdraw: `myEntrant` finds me now.
    expect(event().entrants[0].id).toBe('entry-9')
  })

  // The other side of "reconcile on settle": when the FAILURE is an outage, the
  // reconcile refetch fails too. That must not cost the player the page they were
  // looking at — a network blip on a click is a toast, not a teardown. (The detail
  // query only throws to the boundary while it has NO data; once it has rendered
  // once, a failed background refetch keeps the last-good view.)
  it('survives an outage: the reconcile refetch fails, the last-good view stays, the error toasts', async () => {
    let reads = 0
    mockTournamentDetailEndpoint(server, () => {
      reads += 1
      if (reads > 1) {
        return HttpResponse.json({ detail: 'Server error.' }, { status: 500 })
      }
      return HttpResponse.json(
        buildTournamentDetailRead({
          id: 't-1',
          events: [buildTournamentEventRead({ id: 'ev-1', entrants: [] })],
        }),
      )
    })
    mockEventEnterEndpoint(server, () =>
      HttpResponse.json({ detail: 'Server error.' }, { status: 500 }),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(
      () => ({ detail: useTournament('t-1'), enter: useEnterEvent('t-1') }),
      { wrapper },
    )

    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())

    result.current.enter.mutate('ev-1')
    await waitForRaw(() => expect(result.current.enter.isError).toBe(true))
    await waitForRaw(() => expect(reads).toBeGreaterThan(1))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't enter the event",
      expect.objectContaining({ description: 'Server error.' }),
    )
    // The page is still there, still showing what it last knew.
    expect(result.current.detail.data!.events[0].entered).toBe(0)
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

  // Withdraw's stale-tab race lands on its SUCCESS path (a repeat withdrawal is an
  // idempotent 204), which is why it looked fine while entering did not. That was
  // luck, not design: a withdrawal that genuinely fails is the same "my view and
  // the server disagree" moment, so it reconciles on settle too.
  it('invalidates on failure too — a rejected withdrawal cannot leave a stale card', async () => {
    mockEventWithdrawEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'You can only withdraw your own entry.' },
        { status: 403 },
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useWithdrawEntry('t-1'), { wrapper })
    result.current.mutate({ eventId: 'ev-1', entryId: 'entry-other' })

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
  })
})

// The round trip, driven through the DEFAULT handlers and the dev store rather
// than a per-test stub: entering has to make the *next read* of that event show
// the entrant AND an incremented count — a store that updated the list but not
// the count (or vice versa) is exactly the drift the derived count exists to
// make impossible.
describe('entering and withdrawing, against the stateful mock store', () => {
  beforeEach(() => resetTournamentsStore())

  const TOURNAMENT = BAY_AREA_OPEN_ID
  const EVENT = mockUuid('ev-u1500') // seeded with nobody in it

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

// ----- the draw (ADR-0786) -------------------------------------------------

/** The 201 body of `POST …/draw`: the fixtures the cut produced. */
function drawnPair(): TournamentFixtureRead[] {
  return [
    buildTournamentFixtureRead({
      id: 'fx-1',
      group_id: 'p-1',
      round: 1,
      position: 1,
      entry_a_id: 'entry-1',
      entry_b_id: 'entry-2',
    }),
  ]
}

describe('useCutDraw', () => {
  it('posts to the event’s draw resource with NO body, and resolves the parsed fixtures', async () => {
    let seen: { url: string; body: string } | null = null
    mockEventCutDrawEndpoint(server, async ({ request }) => {
      seen = { url: request.url, body: await request.text() }
      return HttpResponse.json(drawnPair(), { status: 201 })
    })

    const { result } = renderHook(() => useCutDraw('t-1'))
    const fixtures = await result.current.mutateAsync('ev-1')

    expect(seen!.url).toContain('/v1/tournaments/t-1/events/ev-1/draw')
    // The event IS the request — a cut is planned from the field the server already
    // holds, so there is nothing for the client to send.
    expect(seen!.body).toBe('')
    // …and what comes back is PARSED, in the domain's camelCase — not the wire shape.
    expect(fixtures).toEqual([
      {
        id: 'fx-1',
        stageId: 's-1',
        groupId: 'p-1',
        round: 1,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-2',
        winnerEntryId: null,
        matchId: null,
        matchStatus: null,
        tableId: null,
        scheduledStart: null,
        tableOffReservation: null,
        startOutsideReservationWindow: null,
        pinnedAt: null,
        callNotifiedCount: 0,
        completedAt: null,
      },
    ])
  })

  // The response is a payload like any other: untrusted. A cut that answered with a
  // malformed fixture must reject the mutation, not hand the caller half a draw.
  it('rejects a malformed fixture in its OWN response', async () => {
    mockEventCutDrawEndpoint(server, () =>
      HttpResponse.json(
        [{ id: 'fx-1', group_id: 'p-1' } as unknown as TournamentFixtureRead],
        { status: 201 },
      ),
    )

    const { result } = renderHook(() => useCutDraw('t-1'))

    await expect(result.current.mutateAsync('ev-1')).rejects.toThrow()
  })

  // THE invalidation contract (the map at the top of `./api`): exactly two keys, the
  // list and this tournament's detail — because the fixtures ride the detail payload and
  // there is no draw query of their own. `toHaveBeenCalledTimes(2)` is the half that
  // makes this a contract rather than a wish: an extra invalidation (a phantom
  // `['tournaments', id, 'draw']` key nothing reads) would sail through the two
  // `toHaveBeenCalledWith`s.
  it('invalidates EXACTLY the list and the detail — no draw key of its own', async () => {
    mockEventCutDrawEndpoint(server, () =>
      HttpResponse.json(drawnPair(), { status: 201 }),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useCutDraw('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  // The 409 (evidence of play) is a STALE-VIEW signal, exactly like the entry and
  // transition 409s: this page offered Re-cut, so as far as it knew nothing had been
  // played — and the server has just told it otherwise. Reconciling only on success
  // would leave the director looking at the same button that was refused.
  it('invalidates on the play-guard 409 too, so the refused view catches up', async () => {
    mockEventCutDrawEndpoint(server, () =>
      HttpResponse.json(
        {
          detail:
            "This event's draw is already under way — at least one fixture has a match or a recorded winner — so it can no longer be cut or removed.",
        },
        { status: 409 },
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useCutDraw('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  // The 422 is the director's to act on, and its SENTENCE is the answer: it names the
  // numbers they have to change ("5 entrants across 3 groups…" — no code could carry
  // that). So the hook does not swallow it and does not decorate it: it REJECTS with the
  // `ApiError`, sentence intact, and the panel that awaited `mutateAsync` renders it
  // inline where the button was (`DrawPanel`, `data/draw.ts`).
  it('rejects a 422 — an event that cannot be planned — with the server’s sentence intact', async () => {
    mockEventCutDrawEndpoint(server, () =>
      HttpResponse.json(
        {
          detail:
            '5 entrants across 3 groups would leave a group with fewer than 2 entrants, who would have nobody to play.',
        },
        { status: 422 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useCutDraw('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    const error = result.current.error as ApiError
    expect(error.status).toBe(422)
    expect(error.detail).toBe(
      '5 entrants across 3 groups would leave a group with fewer than 2 entrants, who would have nobody to play.',
    )
    // …and NO toast. The draw verbs carry no global `onError`, deliberately: their
    // refusals are surfaced inline by the panel, and a toast would tell the director the
    // same thing twice (`web-client/CLAUDE.md`, ## Forms). Asserting the absence is what
    // keeps the toast from creeping back in beside the inline copy.
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('rejects a 403 (not the owner) without a toast — the panel owns the words', async () => {
    mockEventCutDrawEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'Only the creator can cut this draw.' },
        { status: 403 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useCutDraw('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect((result.current.error as ApiError).status).toBe(403)
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('useUncutDraw', () => {
  it('DELETEs the event’s draw resource and resolves on the bodiless 204', async () => {
    let seenUrl = ''
    mockEventUncutDrawEndpoint(server, ({ request }) => {
      seenUrl = request.url
      return new HttpResponse(null, { status: 204 })
    })
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUncutDraw('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(seenUrl).toContain('/v1/tournaments/t-1/events/ev-1/draw')
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  it('invalidates on the play-guard 409 too — the same stale-view argument as the cut', async () => {
    mockEventUncutDrawEndpoint(server, () =>
      HttpResponse.json(
        { detail: "This event's draw is already under way." },
        { status: 409 },
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useUncutDraw('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    const error = result.current.error as ApiError
    expect(error.status).toBe(409)
    expect(error.detail).toBe("This event's draw is already under way.")
    // No toast here either — the panel renders the play-guard refusal inline, beside the
    // draw it refused to remove.
    expect(toast.error).not.toHaveBeenCalled()
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })
})

describe('usePlaceFixture', () => {
  it('PATCHes the placement to the fixture resource and resolves the parsed fixture', async () => {
    let seen: { url: string; body: unknown } | null = null
    mockFixturePlacementEndpoint(server, async ({ request }) => {
      seen = { url: request.url, body: await request.json() }
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-1',
          table_id: 't2',
          scheduled_start: '2026-06-13T10:30:00',
        }),
      )
    })

    const { result } = renderHook(() => usePlaceFixture('t-1'))
    const fixture = await result.current.mutateAsync({
      fixtureId: 'fx-1',
      body: { table_id: 't2', scheduled_start: '2026-06-13T10:30:00' },
    })

    expect(seen!.url).toContain('/v1/tournaments/t-1/fixtures/fx-1/placement')
    expect(seen!.body).toEqual({ table_id: 't2', scheduled_start: '2026-06-13T10:30:00' })
    // Parsed into the domain's camelCase, like every other fixture the layer returns.
    // The predicted start comes back as a `FixtureTime` object (ADR "tournament times
    // are timezone-aware instants") — a UTC instant for geometry + the venue-local label
    // — not the naive wall-clock the WRITE body still sends (the server anchors that).
    expect(fixture).toMatchObject({
      id: 'fx-1',
      tableId: 't2',
      scheduledStart: {
        instant: '2026-06-13T10:30:00Z',
        localLabel: '10:30 AM',
        tzAbbrev: 'CDT',
      },
    })
  })

  // THE invalidation contract (the map at the top of `./api`): exactly the two keys, the
  // list and this tournament's detail — the placement rides the detail payload, so it
  // re-renders from the refetch, with no schedule query of its own.
  it('invalidates EXACTLY the list and the detail — the placement re-renders from the server', async () => {
    mockFixturePlacementEndpoint(server, () =>
      HttpResponse.json(buildTournamentFixtureRead({ id: 'fx-1', table_id: 't2' })),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => usePlaceFixture('t-1'), { wrapper })
    result.current.mutate({
      fixtureId: 'fx-1',
      body: { table_id: 't2', scheduled_start: '2026-06-13T10:30:00' },
    })

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  // Reconciles on FAILURE too (`onSettled`), and toasts — a lost race against a match
  // that finished is a 409, and the refetch corrects the view while the toast reports it.
  it('invalidates on a 409 too, and surfaces it as a toast', async () => {
    mockFixturePlacementEndpoint(server, () =>
      HttpResponse.json({ detail: 'This match is finished.' }, { status: 409 }),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => usePlaceFixture('t-1'), { wrapper })

    await expect(
      result.current.mutateAsync({
        fixtureId: 'fx-1',
        body: { table_id: null, scheduled_start: null },
      }),
    ).rejects.toBeInstanceOf(ApiError)

    await waitForRaw(() => expect(toast.error).toHaveBeenCalled())
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })
})

describe('useRequestScheduleSolve', () => {
  it('POSTs to the solves resource with NO body, and resolves the parsed ledger row', async () => {
    let seen: { url: string; body: string } | null = null
    mockScheduleSolveEndpoint(server, async ({ request }) => {
      seen = { url: request.url, body: await request.text() }
      return HttpResponse.json(
        buildScheduleSolveRead({ status: 'queued', verdict: null }),
        { status: 202 },
      )
    })

    const { result } = renderHook(() => useRequestScheduleSolve('t-1'))
    const solve = await result.current.mutateAsync()

    expect(seen!.url).toContain('/v1/tournaments/t-1/schedule/solves')
    // The tournament is the whole request — the trigger is always `manual` here.
    expect(seen!.body).toBe('')
    // Parsed into the domain's camelCase, never the wire shape.
    expect(solve).toMatchObject({
      id: 'solve-1',
      status: 'queued',
      trigger: 'manual',
      requestedAt: '2026-06-13T09:00:00Z',
    })
  })

  // THE invalidation contract (the map at the top of `./api`): exactly the two keys —
  // the outcome rides the detail payload's `latest_schedule_solve`, so the strip
  // re-renders from the refetch, with no solve query of its own.
  it('invalidates EXACTLY the list and the detail on the 202', async () => {
    mockScheduleSolveEndpoint(server, () =>
      HttpResponse.json(buildScheduleSolveRead({ status: 'queued', verdict: null }), {
        status: 202,
      }),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useRequestScheduleSolve('t-1'), {
      wrapper,
    })
    result.current.mutate()

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  // Reconciles on FAILURE too (`onSettled`) — a 422 means the draws this page shows
  // are not the draws the server holds — and does NOT toast: the strip surfaces every
  // refusal inline (`runSchedulerNotice`), and a mutation whose errors are shown
  // inline must not also toast (web-client/CLAUDE.md, ## Forms).
  it('invalidates on the coded 422 too, and raises no toast of its own', async () => {
    mockScheduleSolveEndpoint(server, () =>
      HttpResponse.json(
        {
          detail: { code: 'no_drawn_events', message: 'Nothing is drawn.' },
        } satisfies CodedErrorBody,
        { status: 422 },
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useRequestScheduleSolve('t-1'), {
      wrapper,
    })

    await expect(result.current.mutateAsync()).rejects.toBeInstanceOf(ApiError)

    await waitForRaw(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] }),
    )
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('refuses a 202 body that is not a ledger row — the parse boundary holds', async () => {
    mockScheduleSolveEndpoint(server, () =>
      HttpResponse.json(
        buildScheduleSolveRead({ status: 'later' as never }),
        { status: 202 },
      ),
    )

    const { result } = renderHook(() => useRequestScheduleSolve('t-1'))
    await expect(result.current.mutateAsync()).rejects.toThrow()
  })
})

// The whole point of the fixtures riding the DETAIL payload (ADR-0786): cutting a draw
// and reading it back are the same page's business, and there is no draw query to keep
// in step. Driven through the DEFAULT handlers and the stateful dev store, so what is
// asserted is the round trip — cut, and the next read of that event carries the draw.
describe('cutting and un-cutting, against the stateful mock store', () => {
  beforeEach(() => resetTournamentsStore())

  const TOURNAMENT = BAY_AREA_OPEN_ID
  /** The seed's `ev-u1200`: round-robin (the only draw type with a generator), ONE
   * group, nine entrants — and seeded already drawn (#1482 caps a round-robin event at
   * one reservation, so one group is all it can hold). */
  const DRAWN = mockUuid('ev-u1200')
  /** Seeded round-robin with **no reservations, and therefore — in this store — no
   * groups**, and nobody entered: the event a cut REFUSES.
   *
   * ⚠️ The refusal is the MOCK's, and since #1483 it is a **known divergence from the
   * real server**, which mints a group for every stage whatever the reservation count
   * and so cuts this event rather than refusing it. The store derives its group count
   * from `reservations.length` unconditionally; closing that gap is #1484's job, and
   * the seed comment on `ev-u1500` in `mocks/tournaments-store.ts` is where the
   * divergence is written down. What is asserted below is therefore that the store
   * refuses what the store cannot plan — not that a director meets this 422 today. */
  const UNCUTTABLE = mockUuid('ev-u1500')

  it('the seeded draw arrives on the detail read, grouped, with no draw on the other events', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(() => useTournament(TOURNAMENT), { wrapper })

    await waitForRaw(() => expect(result.current.data).toBeTruthy())
    const events = result.current.data!.events
    const drawn = events.find((e) => e.id === DRAWN)!

    expect(drawn.fixtures.length).toBeGreaterThan(0)
    // Every fixture names one of its own event's groups — a `group_id` is a string ref
    // into that array, so a draw pointing at a group the event does not have would be a
    // draw nothing could render.
    const groupIds = drawn.groups.map((g) => g.id)
    expect(groupIds.length).toBe(1)
    for (const fixture of drawn.fixtures) {
      expect(groupIds).toContain(fixture.groupId)
      // Nothing has been played: no winner, no match, both sides known (round-robin
      // never has a TBD side — every pairing is known the moment the groups are dealt).
      expect(fixture.winnerEntryId).toBeNull()
      expect(fixture.matchId).toBeNull()
      expect(fixture.entryAId).not.toBeNull()
      expect(fixture.entryBId).not.toBeNull()
    }
    // …and every OTHER event has an empty draw — `[]`, the designed uncut state. One
    // OTHER event in this seed is ALSO drawn: `ev-two-stage-cut` (`rr-then-ko`) —
    // deliberate, so this sweep excludes it by name.
    const alsoDrawn = new Set([mockUuid('ev-two-stage-cut')])
    for (const event of events.filter((e) => e.id !== DRAWN && !alsoDrawn.has(e.id))) {
      expect(event.fixtures).toEqual([])
    }
  })

  it('un-cutting empties the draw on the next read; re-cutting brings it back', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(
      () => ({
        detail: useTournament(TOURNAMENT),
        cut: useCutDraw(TOURNAMENT),
        uncut: useUncutDraw(TOURNAMENT),
      }),
      { wrapper },
    )
    const event = () =>
      result.current.detail.data!.events.find((e) => e.id === DRAWN)!

    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())
    const cutSize = event().fixtures.length
    expect(cutSize).toBeGreaterThan(0)

    await act(() => result.current.uncut.mutateAsync(DRAWN))
    await waitForRaw(() => expect(event().fixtures).toEqual([]))

    await act(() => result.current.cut.mutateAsync(DRAWN))
    // The same field and the same groups cut the same draw — nothing is random
    // (ADR-0786), which is what makes a re-cut a reviewable act rather than a gamble.
    await waitForRaw(() => expect(event().fixtures).toHaveLength(cutSize))
  })

  it('un-cutting an event that never had a draw is a SUCCESS, not a 404 (DELETE is idempotent)', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(() => useUncutDraw(TOURNAMENT), { wrapper })

    result.current.mutate(UNCUTTABLE)

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))
  })

  it('refuses to cut an event that cannot be planned — a groupless draw is a 422', async () => {
    const { wrapper } = setupClient()
    const { result } = renderHookRaw(() => useCutDraw(TOURNAMENT), { wrapper })

    // `ev-u1500` is a round-robin the STORE holds no groups for — there is nowhere to
    // deal the field, so the cut is refused before the entrants are even looked at.
    // What this pins is the client's handling of a 422 from the cut verb: the error is
    // surfaced rather than swallowed, and its status reaches the caller. The real API
    // no longer produces this particular 422 (see `UNCUTTABLE` above), so read the
    // assertion as being about the client, not about the refusal.
    result.current.mutate(UNCUTTABLE)

    await waitForRaw(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as ApiError).status).toBe(422)
  })

  // The play guard. Nothing a client can call materializes a fixture yet (#788), so the
  // store gets there directly — which is the only honest way to reach the state a
  // director will meet the moment the first match exists.
  it('refuses to re-cut or un-cut a draw with evidence of play — and the standing draw survives', async () => {
    const cut = cutDraw(TOURNAMENT, DRAWN)
    if (!cut.ok) throw new Error('the seed should have cut cleanly')
    markFixturePlayed(TOURNAMENT, DRAWN, cut.fixtures[0].id, {
      winner_entry_id: cut.fixtures[0].entry_a_id,
    })

    const { wrapper } = setupClient()
    const { result } = renderHookRaw(
      () => ({
        detail: useTournament(TOURNAMENT),
        cut: useCutDraw(TOURNAMENT),
        uncut: useUncutDraw(TOURNAMENT),
      }),
      { wrapper },
    )
    const event = () =>
      result.current.detail.data!.events.find((e) => e.id === DRAWN)!

    await waitForRaw(() => expect(result.current.detail.data).toBeTruthy())
    const before = event().fixtures.length

    result.current.cut.mutate(DRAWN)
    await waitForRaw(() => expect(result.current.cut.isError).toBe(true))
    expect((result.current.cut.error as ApiError).status).toBe(409)

    result.current.uncut.mutate(DRAWN)
    await waitForRaw(() => expect(result.current.uncut.isError).toBe(true))
    expect((result.current.uncut.error as ApiError).status).toBe(409)

    // A refused cut destroys nothing — the guard's whole promise. The recorded winner is
    // still on the fixture it was recorded on.
    await waitForRaw(() => expect(event().fixtures).toHaveLength(before))
    expect(event().fixtures.filter((f) => f.winnerEntryId !== null)).toHaveLength(1)
  })
})

/** Catches whatever the query throws, so a test can assert that it threw *to a
 * boundary* rather than quietly turning into an empty page. */
class CatchBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? <p>the boundary caught it</p> : this.props.children
  }
}

/** Like `CatchBoundary`, but hands the caught value to `onCatch` so a test can
 * inspect *what* was thrown — a router `notFound()` (`{ isNotFound: true }`) is
 * not an `Error`, so "did it throw a notFound or an ApiError" is a real question. */
class CaptureBoundary extends Component<
  { children: ReactNode; onCatch: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    this.props.onCatch(error)
  }

  render() {
    return this.state.failed ? <p>the boundary caught it</p> : this.props.children
  }
}

// The parse boundary, from the outside: what a COMPONENT experiences when the server
// sends a draw that is not a draw (`.claude/rules/parse-at-boundaries.md`).
//
// This is the case the whole `fixtures` Zod schema exists for, and it is why the mapping
// moved into the `queryFn`: TanStack Query *catches* a throw from `select`, leaving the
// raw payload in the cache and an error result the detail route reads as "not found" —
// so a malformed draw used to be able to render a **"Tournament not found"** page for a
// tournament the server had just sent. Parsed in the `queryFn`, it is a failed fetch:
// the boundary gets it, and the cache is never primed with the bad payload.
describe('a malformed fixture on the detail payload', () => {
  function brokenDetail() {
    return buildTournamentDetailRead({
      id: 't-1',
      events: [
        buildTournamentEventRead({
          id: 'ev-1',
          // No `round`, no `position` — a shape `schema.d.ts` swears cannot arrive.
          fixtures: [
            { id: 'fx-1', group_id: 'p-1' } as unknown as TournamentFixtureRead,
          ],
        }),
      ],
    })
  }

  it('fails the query and reaches the error boundary — it does not render an empty page', async () => {
    // React logs the caught error; the boundary is the assertion, not the console.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockTournamentDetailEndpoint(server, () => HttpResponse.json(brokenDetail()))

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    function Page() {
      const { data } = useTournament('t-1')
      return <p>{data ? data.name : 'no tournament'}</p>
    }
    render(
      <QueryClientProvider client={queryClient}>
        <CatchBoundary>
          <Page />
        </CatchBoundary>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('the boundary caught it')).toBeInTheDocument()
    // And nothing malformed got into the cache on the way — a bad payload that primed
    // the cache would be read back as good by the next component to mount.
    expect(queryClient.getQueryData(['tournaments', 't-1'])).toBeUndefined()
  })
})
