import { type HttpResponseResolver, http } from 'msw'

import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'
import type { ErrorBody, ValidationErrorBody } from '../error-body'

type Backend = typeof server | typeof worker

/** Resolver for the **schedule-preview enqueue** endpoint (ADR "a schedule
 * preview is a non-persistent solve over a synthetic field") — the `202`
 * `PreviewEnqueued` (token + the instant structure), or an error envelope: 403
 * (not the owner), 409/422 (not pre-live, or an unpreviewable draw type), 429
 * (rate-limited), 404. The body is the optional per-event field-size overrides. */
export type SchedulePreviewEnqueueResolver = HttpResponseResolver<
  { tournamentId: string },
  components['schemas']['PreviewRequest'] | null,
  components['schemas']['PreviewEnqueued'] | ErrorBody | ValidationErrorBody
>

/** POST /v1/tournaments/{id}/schedule/preview — enqueue an ephemeral preview. */
export const mockSchedulePreviewEnqueueEndpoint = (
  backend: Backend,
  resolver: SchedulePreviewEnqueueResolver,
) =>
  backend.use(
    http.post('*/v1/tournaments/:tournamentId/schedule/preview', resolver),
  )

/** Resolver for the **schedule-preview poll** endpoint — a `200` `PreviewJobState`
 * (the status, plus the `PreviewResult` once `done` / the `error` once `failed`),
 * or an error envelope on a 403 / 404. */
export type SchedulePreviewPollResolver = HttpResponseResolver<
  { tournamentId: string; token: string },
  never,
  components['schemas']['PreviewJobState'] | ErrorBody
>

/** GET /v1/tournaments/{id}/schedule/preview/{token} — poll a preview by token. */
export const mockSchedulePreviewPollEndpoint = (
  backend: Backend,
  resolver: SchedulePreviewPollResolver,
) =>
  backend.use(
    http.get(
      '*/v1/tournaments/:tournamentId/schedule/preview/:token',
      resolver,
    ),
  )

/** Resolver for the **schedule-preview cancel** endpoint — a bodiless `204`
 * (including for an unknown/expired token: best-effort and idempotent), or an
 * error envelope on a 403 / 404. */
export type SchedulePreviewCancelResolver = HttpResponseResolver<
  { tournamentId: string; token: string },
  never,
  ErrorBody | null
>

/** DELETE /v1/tournaments/{id}/schedule/preview/{token} — best-effort cancel. */
export const mockSchedulePreviewCancelEndpoint = (
  backend: Backend,
  resolver: SchedulePreviewCancelResolver,
) =>
  backend.use(
    http.delete(
      '*/v1/tournaments/:tournamentId/schedule/preview/:token',
      resolver,
    ),
  )
