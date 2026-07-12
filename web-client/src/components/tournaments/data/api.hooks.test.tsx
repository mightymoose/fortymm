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
  mockTournamentTransitionEndpoint,
  mockTournamentUpdateEndpoint,
  mockTournamentsListEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import {
  buildTournamentDetailRead,
  buildTournamentEntrantRead,
  buildTournamentEventRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { resetTournamentsStore } from '@/mocks/tournaments-store'
import { ApiError } from '@/api/client'
import type { components } from '@/api/schema'
import {
  useCreateTournament,
  useEnterEvent,
  useTournament,
  useTournaments,
  useTransitionTournament,
  useUpdateTournament,
  useWithdrawEntry,
} from './api'

type TournamentUpdate = components['schemas']['TournamentUpdate']

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return { ...actual, toast: { ...actual.toast, error: vi.fn(), info: vi.fn() } }
})

/** Both toast channels start clean: the entry cases assert not just which toast
 * fired, but that the *other* one did not (a benign 409 that also raised a red
 * error toast would satisfy a one-sided assertion). */
beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.info).mockClear()
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
    const moved = await result.current.mutateAsync('published')

    expect(seen!.url).toContain('/v1/tournaments/t-1/transitions')
    // `to` alone: the tournament already knows where it *is*, and a stale client
    // that also sent `from` would only be reporting what it believed (ADR-0017).
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
    result.current.mutate('live')

    await waitForRaw(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tournaments', 't-1'],
    })
  })

  // The stale-tab race (ADR-0017's reason for 409-ing a re-assertion): tab A
  // published; THIS tab still reads `draft`, so it still offers Publish. The
  // refusal has to be VISIBLE — a swallowed 409 is a button that does nothing —
  // and the verb names the edge the user clicked, not the wire call.
  it('surfaces an illegal-edge 409 as an error toast naming what they clicked', async () => {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json(
        {
          detail:
            'This tournament is published; it cannot be moved to published.',
        },
        { status: 409 },
      ),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useTransitionTournament('t-1'), {
      wrapper,
    })
    result.current.mutate('published')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't publish the tournament",
      expect.objectContaining({
        description:
          'This tournament is published; it cannot be moved to published.',
      }),
    )
    // A 409 here is a genuine refusal — nothing moved. Unlike the entry 409 (which
    // means "you are already in"), it must NOT be downgraded to an info note.
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('invalidates on the 409 too, so the stale view catches up to the status it was refused', async () => {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json(
        {
          detail:
            'This tournament is published; it cannot be moved to published.',
        },
        { status: 409 },
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useTransitionTournament('t-1'), {
      wrapper,
    })
    result.current.mutate('published')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    // Without this, the tab keeps offering Publish on a tournament the server has
    // just told it is already published — the same freeze #943 found on entries.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['tournaments', 't-1'],
    })
  })

  it('names the edge in the failure toast: ending a tournament reads as ending it', async () => {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json({ detail: 'Server error.' }, { status: 500 }),
    )
    const { wrapper } = setupClient()

    const { result } = renderHookRaw(() => useTransitionTournament('t-1'), {
      wrapper,
    })
    result.current.mutate('archived')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't end the tournament",
      expect.objectContaining({ description: 'Server error.' }),
    )
  })
})

// The lifecycle end to end through the stateful dev store, which enforces the
// SAME edge table as the server: a mock that let an illegal edge through would
// let a broken UI look fine in dev and in vitest alike.
describe('the lifecycle, against the stateful mock store', () => {
  beforeEach(() => resetTournamentsStore())

  const DRAFT = 'summer-slam-2026' // seeded `draft`, owned by the dev user

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

    await act(() => result.current.move.mutateAsync('published'))
    await waitForRaw(() =>
      expect(result.current.detail.data!.status).toBe('published'),
    )

    await act(() => result.current.move.mutateAsync('live'))
    await waitForRaw(() => expect(result.current.detail.data!.status).toBe('live'))

    await act(() => result.current.move.mutateAsync('archived'))
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

    result.current.move.mutate('live')
    await waitForRaw(() => expect(result.current.move.isError).toBe(true))

    expect((result.current.move.error as ApiError).status).toBe(409)
    await waitForRaw(() => expect(result.current.detail.data!.status).toBe('draft'))
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

  // The stale-tab race, at the level the bug lives: a 409 means the server and
  // this screen disagree, so the *failed* mutation has to re-read the server too.
  // Invalidating only `onSuccess` left the card frozen on the pre-click render it
  // had just been proven wrong about.
  it('invalidates on FAILURE too, so a 409 reconciles the view instead of freezing it', async () => {
    mockEventEnterEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'You have already entered this event.' },
        { status: 409 },
      ),
    )
    const { invalidateSpy, wrapper } = setupClient()

    const { result } = renderHookRaw(() => useEnterEvent('t-1'), { wrapper })
    result.current.mutate('ev-1')

    await waitForRaw(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments', 't-1'] })
  })

  it('treats a duplicate-entry 409 as benign: an informational note, not a red error', async () => {
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

    // "You have already entered" is not a failure the player caused or can fix —
    // they ARE entered, and the reconciled card now says so. An error toast on top
    // of a screen that reads "Withdraw" would contradict it.
    expect(toast.info).toHaveBeenCalledWith(
      'You were already entered in this event',
      expect.objectContaining({
        description: "We've refreshed it with the latest entries.",
      }),
    )
    expect(toast.error).not.toHaveBeenCalled()
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
    mockEventEnterEndpoint(server, () =>
      // The server is right and the screen is wrong: this player is already in.
      HttpResponse.json(
        { detail: 'You have already entered this event.' },
        { status: 409 },
      ),
    )
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
