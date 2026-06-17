import { type HttpResponseResolver, http } from 'msw'

import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'
import type { ErrorBody, ValidationErrorBody } from '../error-body'

type Backend = typeof server | typeof worker
type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentRead = components['schemas']['TournamentRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']

/** A tournament-write response — the created/updated `TournamentRead` (events
 * live on their own endpoints), or an error envelope so tests can drive 4xx
 * paths through the same typed resolver. */
type TournamentWriteBody = TournamentRead | ErrorBody | ValidationErrorBody

/** An event-write response — the created/updated `TournamentEventRead`, or an
 * error envelope. */
type EventWriteBody = TournamentEventRead | ErrorBody | ValidationErrorBody

/** Resolver for the list endpoint — returns the `TournamentDetailRead[]`
 * payload (events included). */
export type TournamentsListResolver = HttpResponseResolver<
  never,
  never,
  TournamentDetailRead[]
>

/** GET /v1/tournaments — the admin list (newest first, events included). */
export const mockTournamentsListEndpoint = (
  backend: Backend,
  resolver: TournamentsListResolver,
) => backend.use(http.get('*/v1/tournaments', resolver))

/** Resolver for the detail endpoint — returns one `TournamentDetailRead`, or an
 * error envelope on a 404. */
export type TournamentDetailResolver = HttpResponseResolver<
  { tournamentId: string },
  never,
  TournamentDetailRead | ErrorBody
>

/** GET /v1/tournaments/{id} — the detail page payload. */
export const mockTournamentDetailEndpoint = (
  backend: Backend,
  resolver: TournamentDetailResolver,
) => backend.use(http.get('*/v1/tournaments/:tournamentId', resolver))

/** Resolver for the create endpoint — returns the created `TournamentRead` (no
 * events; create makes a bare tournament) or an error envelope on a 4xx. */
export type TournamentCreateResolver = HttpResponseResolver<
  never,
  components['schemas']['TournamentCreate'],
  TournamentWriteBody
>

/** POST /v1/tournaments — create. */
export const mockTournamentCreateEndpoint = (
  backend: Backend,
  resolver: TournamentCreateResolver,
) => backend.use(http.post('*/v1/tournaments', resolver))

/** Resolver for the update endpoint — returns the updated `TournamentRead` or
 * an error envelope on a 4xx (403 non-creator / 404 missing). */
export type TournamentUpdateResolver = HttpResponseResolver<
  { tournamentId: string },
  components['schemas']['TournamentUpdate'],
  TournamentWriteBody
>

/** PATCH /v1/tournaments/{id} — partial update. */
export const mockTournamentUpdateEndpoint = (
  backend: Backend,
  resolver: TournamentUpdateResolver,
) => backend.use(http.patch('*/v1/tournaments/:tournamentId', resolver))

/** Resolver for the delete endpoint — a 204 with no body, or an error envelope
 * on a 4xx (403 non-creator / 404 already deleted). */
export type TournamentDeleteResolver = HttpResponseResolver<
  { tournamentId: string },
  never,
  ErrorBody | null
>

/** DELETE /v1/tournaments/{id}. */
export const mockTournamentDeleteEndpoint = (
  backend: Backend,
  resolver: TournamentDeleteResolver,
) => backend.use(http.delete('*/v1/tournaments/:tournamentId', resolver))

/** Resolver for the event create endpoint. */
export type EventCreateResolver = HttpResponseResolver<
  { tournamentId: string },
  components['schemas']['TournamentEventCreate'],
  EventWriteBody
>

/** POST /v1/tournaments/{id}/events — create an event. */
export const mockEventCreateEndpoint = (
  backend: Backend,
  resolver: EventCreateResolver,
) => backend.use(http.post('*/v1/tournaments/:tournamentId/events', resolver))

/** Resolver for the event update endpoint. */
export type EventUpdateResolver = HttpResponseResolver<
  { tournamentId: string; eventId: string },
  components['schemas']['TournamentEventUpdate'],
  EventWriteBody
>

/** PATCH /v1/tournaments/{id}/events/{eventId} — update an event. */
export const mockEventUpdateEndpoint = (
  backend: Backend,
  resolver: EventUpdateResolver,
) =>
  backend.use(
    http.patch('*/v1/tournaments/:tournamentId/events/:eventId', resolver),
  )

/** Resolver for the event delete endpoint. */
export type EventDeleteResolver = HttpResponseResolver<
  { tournamentId: string; eventId: string },
  never,
  ErrorBody | null
>

/** DELETE /v1/tournaments/{id}/events/{eventId} — delete an event. */
export const mockEventDeleteEndpoint = (
  backend: Backend,
  resolver: EventDeleteResolver,
) =>
  backend.use(
    http.delete('*/v1/tournaments/:tournamentId/events/:eventId', resolver),
  )
