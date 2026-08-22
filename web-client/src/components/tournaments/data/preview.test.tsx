import { useQuery } from '@tanstack/react-query'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderHook, waitFor } from '@/test/utilities'
import {
  mockSchedulePreviewCancelEndpoint,
  mockSchedulePreviewEnqueueEndpoint,
  mockSchedulePreviewPollEndpoint,
} from '@/mocks/endpoints/tournaments/preview.endpoint'
import {
  buildInfeasiblePreviewResult,
  buildPreviewEnqueued,
  buildPreviewJobState,
} from '@/mocks/factories/tournaments/preview.factory'
import { server } from '@/mocks/server'
import { resetSchedulePreviewStore } from '@/mocks/schedule-preview-store'
import type { components } from '@/api/schema'
import {
  PREVIEW_POLL_MS,
  previewPollInterval,
  schedulePreviewQueryOptions,
  useCancelSchedulePreview,
  useEnqueueSchedulePreview,
} from './preview'

type PreviewJobState = components['schemas']['PreviewJobState']

// The default handlers walk a token queued → running → done over three polls, so
// each test starts from an empty preview store — a token minted in one test must
// not leak its poll count into the next.
beforeEach(() => resetSchedulePreviewStore())

// ----- the poll cadence, as a pure function -----------------------------------

describe('previewPollInterval', () => {
  it('keeps polling while the job is in flight', () => {
    expect(previewPollInterval('queued')).toBe(PREVIEW_POLL_MS)
    expect(previewPollInterval('running')).toBe(PREVIEW_POLL_MS)
  })

  it('stops polling once the job is terminal — a done/failed job never changes again', () => {
    expect(previewPollInterval('done')).toBe(false)
    expect(previewPollInterval('failed')).toBe(false)
  })

  it('schedules the first poll before any read has landed', () => {
    expect(previewPollInterval(undefined)).toBe(PREVIEW_POLL_MS)
  })
})

// ----- enqueue ----------------------------------------------------------------

describe('useEnqueueSchedulePreview', () => {
  it('POSTs the overrides and resolves the parsed token + instant structure', async () => {
    let seen: { url: string; body: unknown } | null = null
    mockSchedulePreviewEnqueueEndpoint(server, async ({ request }) => {
      seen = { url: request.url, body: await request.json() }
      return HttpResponse.json(buildPreviewEnqueued({ token: 'tok-9' }), {
        status: 202,
      })
    })

    const { result } = renderHook(() => useEnqueueSchedulePreview('t-1'))
    const enqueued = await result.current.mutateAsync({
      overrides: { 'ev-1': 24 },
    })

    expect(seen!.url).toContain('/v1/tournaments/t-1/schedule/preview')
    // The per-event override map rides `overrides` on the body.
    expect(seen!.body).toEqual({ overrides: { 'ev-1': 24 } })
    // …and what comes back is PARSED into the domain's camelCase — token, the
    // field sizes, and the drawn fixtures the modal renders a skeleton from.
    expect(enqueued.token).toBe('tok-9')
    expect(enqueued.fieldSummaries[0]).toEqual({ eventId: 'ev-1', fieldSize: 4 })
    expect(enqueued.fixtures[0]).toMatchObject({
      fixtureId: expect.any(String),
      eventId: 'ev-1',
      // The namespaced composite the solver keys by is carried, but the human
      // reservation name is what the grid renders.
      reservationId: 'ev-1:res-1',
      reservationName: 'Reservation A',
      playerAId: 'placeholder-1',
      playerBId: 'placeholder-2',
    })
  })

  it('sends an empty body when there are no overrides', async () => {
    let body: unknown = null
    mockSchedulePreviewEnqueueEndpoint(server, async ({ request }) => {
      body = await request.json()
      return HttpResponse.json(buildPreviewEnqueued(), { status: 202 })
    })

    const { result } = renderHook(() => useEnqueueSchedulePreview('t-1'))
    await result.current.mutateAsync({})

    expect(body).toEqual({})
  })

  it('rejects a 202 body that is not an enqueue envelope — the parse boundary holds', async () => {
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(
        // No `field_summaries`, no `fixtures` — a shape `schema.d.ts` swears
        // cannot arrive.
        { token: 'tok-1' } as unknown as components['schemas']['PreviewEnqueued'],
        { status: 202 },
      ),
    )

    const { result } = renderHook(() => useEnqueueSchedulePreview('t-1'))
    await expect(result.current.mutateAsync({})).rejects.toThrow()
  })
})

// ----- poll: the streamed solve -----------------------------------------------

describe('schedulePreviewQueryOptions', () => {
  it('is idle for a null token — no tokenless request goes out', () => {
    const { result } = renderHook(() =>
      useQuery(schedulePreviewQueryOptions('t-1', null)),
    )
    // `enabled: false` — the query never fetches, so it stays pending with no data.
    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.data).toBeUndefined()
  })

  // The whole streaming mechanism the modal consumes, end to end through the
  // DEFAULT store: enqueue a preview, then poll its token until the Zod-validated
  // result arrives — the first read is in-flight (queued/running) with no result,
  // and a later read is `done` carrying the parsed `PreviewResult`.
  it('streams a token from in-flight to a parsed done result', async () => {
    const enqueue = renderHook(() => useEnqueueSchedulePreview('t-1'))
    const enqueued = await enqueue.result.current.mutateAsync({})

    const poll = renderHook(() =>
      useQuery(schedulePreviewQueryOptions('t-1', enqueued.token)),
    )

    // The first read: in flight, and NOT yet carrying a result — the labeled wait
    // the modal shows.
    await waitFor(() => expect(poll.result.current.data).toBeTruthy())
    expect(['queued', 'running']).toContain(poll.result.current.data!.status)
    expect(poll.result.current.data!.result).toBeNull()

    // …and it resolves on its own (the refetchInterval keeps polling) to `done`
    // with the parsed result.
    await waitFor(() =>
      expect(poll.result.current.data!.status).toBe('done'),
    )
    const done = poll.result.current.data!
    expect(done.result).not.toBeNull()
    // The default field is four players → six round-robin matches, and the day
    // fits — verdict-first, in the domain's camelCase.
    expect(done.result).toMatchObject({
      verdict: 'optimal',
      fits: true,
      totalMatches: 6,
      totalByes: 0,
      estimatedDurationMin: 180,
    })
    expect(done.result!.infeasibilityReasons).toEqual([])
    expect(done.result!.notes.length).toBeGreaterThan(0)
  })

  it('parses an infeasible result and maps its reasons to the domain union', async () => {
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json(
        buildPreviewJobState({
          status: 'done',
          result: buildInfeasiblePreviewResult(),
        }),
      ),
    )

    const { result } = renderHook(() =>
      useQuery(schedulePreviewQueryOptions('t-1', 'tok-infeasible')),
    )

    await waitFor(() => expect(result.current.data?.status).toBe('done'))
    const preview = result.current.data!.result!
    expect(preview).toMatchObject({
      verdict: 'infeasible',
      fits: false,
      estimatedDurationMin: null,
      estimatedFinish: null,
    })
    // The reason is mapped snake→camel through `./solve`'s discriminated union —
    // `reservation_name` → `reservationName`, the `kind` discriminant preserved.
    expect(preview.infeasibilityReasons).toEqual([
      {
        kind: 'reservation_has_no_tables',
        reservationName: 'Reservation A',
        reservation: 'booked',
      },
    ])
  })

  it('surfaces a failed job honestly — status failed, no result, the error carried', async () => {
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json(
        buildPreviewJobState({ status: 'failed', error: 'The preview job broke.' }),
      ),
    )

    const { result } = renderHook(() =>
      useQuery(schedulePreviewQueryOptions('t-1', 'tok-failed')),
    )

    await waitFor(() => expect(result.current.data?.status).toBe('failed'))
    expect(result.current.data!.result).toBeNull()
    expect(result.current.data!.error).toBe('The preview job broke.')
  })

  // The parse boundary, from the outside: a poll body whose `status` is an enum
  // member this client does not know must FAIL the query, not leak a bad value
  // into the modal's `switch` (`.claude/rules/parse-at-boundaries.md`).
  it('rejects a misshaped poll body at the Zod boundary', async () => {
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json({ status: 'later' } as unknown as PreviewJobState),
    )

    const { result } = renderHook(() =>
      useQuery(schedulePreviewQueryOptions('t-1', 'tok-bad')),
    )

    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})

// ----- cancel -----------------------------------------------------------------

describe('useCancelSchedulePreview', () => {
  it('DELETEs the token and resolves on the bodiless 204', async () => {
    let seenUrl = ''
    mockSchedulePreviewCancelEndpoint(server, ({ request }) => {
      seenUrl = request.url
      return new HttpResponse(null, { status: 204 })
    })

    const { result } = renderHook(() => useCancelSchedulePreview('t-1'))
    await result.current.mutateAsync('tok-9')

    expect(seenUrl).toContain('/v1/tournaments/t-1/schedule/preview/tok-9')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  // Best-effort/idempotent: cancelling drops the job, so a later poll of the same
  // token reads `failed` (the reclaimed-slot / expired-result state) — proven end
  // to end through the default store.
  it('drops the job so a later poll reads failed', async () => {
    const enqueue = renderHook(() => useEnqueueSchedulePreview('t-1'))
    const enqueued = await enqueue.result.current.mutateAsync({})

    const cancel = renderHook(() => useCancelSchedulePreview('t-1'))
    await cancel.result.current.mutateAsync(enqueued.token)

    const poll = renderHook(() =>
      useQuery(schedulePreviewQueryOptions('t-1', enqueued.token)),
    )
    await waitFor(() => expect(poll.result.current.data?.status).toBe('failed'))
  })
})
