// The real-API data layer for the tournament-admin UI. Exports the same surface
// the route components used from the old in-memory `./store` — `useTournaments`,
// `useTournament`, `useTables`, plus create/update/delete hooks — so the routes
// stay thin. The mappers below translate between the API's snake_case wire
// shapes (`@/api/schema`) and the camelCase prototype domain types (`./types`),
// and are unit-tested in `./api.test.ts`.

import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'

import { ApiError, api, unwrap } from '@/api/client'
import { notifyError } from '@/lib/notify-error'
import type { components } from '@/api/schema'
import type {
  Entrant,
  Pool,
  Predicate,
  PredicateValue,
  Tournament,
  TournamentEvent,
  TournamentTable,
} from './types'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentRead = components['schemas']['TournamentRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
type TournamentCreate = components['schemas']['TournamentCreate']
type TournamentUpdate = components['schemas']['TournamentUpdate']
type TournamentEventCreate = components['schemas']['TournamentEventCreate']
type TournamentEventUpdate = components['schemas']['TournamentEventUpdate']
type ApiPool = components['schemas']['Pool']
type ApiPredicate = components['schemas']['Predicate']

/** The API types a `between` predicate's value as a variable-length
 * `(number | null)[]`; the prototype narrows it to a `[min, max]` tuple. Coerce
 * the array form into the tuple, leaving scalar/null values untouched. */
function apiToPredicateValue(value: ApiPredicate['value']): PredicateValue {
  if (Array.isArray(value)) {
    return [value[0] ?? null, value[1] ?? null]
  }
  return value
}

function apiToPredicate(p: ApiPredicate): Predicate {
  return { id: p.id, field: p.field, op: p.op, value: apiToPredicateValue(p.value) }
}

// ----- adapters: API (snake_case) <-> prototype (camelCase) ----------------

/** Map an API entrant to the prototype's `Entrant`. */
export function apiToEntrant(e: TournamentEntrantRead): Entrant {
  return { id: e.id, userId: e.user_id, username: e.username, seed: e.seed }
}

/** Map an API event payload to the prototype's `TournamentEvent`. `entered`
 * comes straight off the wire: the server derives it from the same active
 * entries it lists in `entrants`, so the two always agree. */
export function apiToEvent(e: TournamentEventRead): TournamentEvent {
  return {
    id: e.id,
    name: e.name,
    format: e.format,
    drawType: e.draw_type,
    maxPlayers: e.max_players,
    entryFee: e.entry_fee,
    entered: e.entered,
    entrants: e.entrants.map(apiToEntrant),
    slot: e.slot,
    predicates: e.predicates.map(apiToPredicate),
    match: { rated: e.match_settings.rated, lengthGames: e.match_settings.length_games },
    pools: e.pools.map(apiToPool),
  }
}

function apiToPool(p: ApiPool): Pool {
  return { id: p.id, name: p.name, slot: p.slot, tableIds: p.table_ids }
}

/** Map an API tournament (list or detail; both return `TournamentDetailRead`)
 * to the prototype's `Tournament`. The tournament's `table_catalogue` IS the
 * catalogue, so `tableIds` is just its ids. */
export function apiToTournament(t: TournamentDetailRead): Tournament {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    canEdit: t.can_edit,
    description: t.description ?? '',
    startDate: t.start_date,
    endDate: t.end_date,
    address: t.address,
    tableIds: t.table_catalogue.map((tbl) => tbl.id),
    events: t.events.map(apiToEvent),
  }
}

/** Build the `TournamentCreate` body from a prototype draft (the "New
 * tournament" modal). The modal collects no tables, so `table_catalogue` is the
 * empty array the bare-create endpoint expects. */
export function draftToCreateBody(
  draft: Omit<Tournament, 'id'>,
): TournamentCreate {
  return {
    name: draft.name,
    description: draft.description,
    status: draft.status,
    start_date: draft.startDate,
    end_date: draft.endDate,
    address: draft.address,
    table_catalogue: [],
  }
}

/** Build the tournament-level `TournamentUpdate` body from an edited prototype
 * `Tournament` and the full table catalogue. Events are NOT included — they
 * have their own endpoints. The catalogue is sent as-is (the Tables tab edits
 * it directly: assign IS catalogue here, since the API has no separate global
 * table list), so a Tables-tab edit round-trips the label/court, not just ids. */
export function tournamentToUpdateBody(
  t: Tournament,
  catalogue: TournamentTable[],
): TournamentUpdate {
  return {
    name: t.name,
    description: t.description,
    status: t.status,
    start_date: t.startDate,
    end_date: t.endDate,
    address: t.address,
    table_catalogue: catalogue,
  }
}

function eventPoolsToApi(ev: TournamentEvent) {
  return ev.pools.map((p) => ({
    id: p.id,
    name: p.name,
    slot: p.slot,
    table_ids: p.tableIds,
  }))
}

/** The event fields shared by the create and update bodies — everything except
 * the server-managed `entered` count. */
function eventToApiFields(ev: TournamentEvent) {
  return {
    name: ev.name,
    format: ev.format,
    draw_type: ev.drawType,
    max_players: ev.maxPlayers,
    entry_fee: ev.entryFee,
    slot: ev.slot,
    match_settings: { rated: ev.match.rated, length_games: ev.match.lengthGames },
    predicates: ev.predicates,
    pools: eventPoolsToApi(ev),
  }
}

/** Build the event *create* body (POST) from a prototype `TournamentEvent`. */
export function eventToCreateBody(ev: TournamentEvent): TournamentEventCreate {
  return eventToApiFields(ev)
}

/** Build the event *update* body (PATCH) from a prototype `TournamentEvent`.
 * `entered` is deliberately omitted: it's a server-managed registration count
 * the editor never touches, so echoing the client's last-read value back would
 * clobber registrations that changed server-side since load (a lost update). */
export function eventToUpdateBody(ev: TournamentEvent): TournamentEventUpdate {
  return eventToApiFields(ev)
}

// ----- query keys ----------------------------------------------------------

const TOURNAMENTS_KEY = ['tournaments'] as const
const tournamentKey = (id: string) => ['tournaments', id] as const

/** Invalidate both the list and one tournament's detail after a mutation. */
function invalidateTournament(qc: QueryClient, id: string) {
  qc.invalidateQueries({ queryKey: TOURNAMENTS_KEY })
  qc.invalidateQueries({ queryKey: tournamentKey(id) })
}

// ----- queries -------------------------------------------------------------

/** The tournament list, mapped to prototype `Tournament[]`. A 403 (a permitted
 * non-creator the server still gates) bubbles to the `RbacBoundary`. */
export function useTournaments(): Tournament[] {
  const { data } = useQuery({
    queryKey: TOURNAMENTS_KEY,
    queryFn: async (): Promise<Tournament[]> => {
      const rows = unwrap('load tournaments', await api.GET('/v1/tournaments'))
      return rows.map(apiToTournament)
    },
    throwOnError: true,
    retry: false,
  })
  return data ?? []
}

/** The detail query, shared by `useTournament` and `useTables` so both read one
 * cache entry from a single fetch. It returns the raw `TournamentDetailRead` (or
 * `null` on 404); each consumer selects its own projection. A 403 bubbles to the
 * `RbacBoundary`; any other error throws. */
function tournamentDetailQuery(id: string) {
  return queryOptions({
    queryKey: tournamentKey(id),
    queryFn: async (): Promise<TournamentDetailRead | null> => {
      const result = await api.GET('/v1/tournaments/{tournament_id}', {
        params: { path: { tournament_id: id } },
      })
      // A 404 is an expected "doesn't exist" — resolve to null rather than
      // throw, so the route renders its own not-found screen.
      if (result.response?.status === 404) return null
      return unwrap('load tournament', result)
    },
    // Bubble everything except a 404 (which resolved to null above and never
    // reaches here as an error) — but only while there is NOTHING on screen. A
    // 403 on load still reaches the RbacBoundary.
    //
    // `throwOnError` fires on *background refetch* failures too, not just the
    // first load. Since the entry mutations now reconcile on settle (see below),
    // a click during an outage would trigger a refetch that fails and throw the
    // whole rendered tournament away — a network blip on Enter is a toast, not a
    // teardown. With data in hand we keep the last-good view and let the
    // mutation's own error toast carry the failure.
    throwOnError: (error, query) =>
      !(error instanceof ApiError && error.status === 404) &&
      query.state.data === undefined,
    retry: false,
  })
}

/** A single tournament's detail, mapped to a prototype `Tournament` — or `null`
 * when the id 404s (so the detail route can show its "not found" UI). */
export function useTournament(id: string) {
  return useQuery({
    ...tournamentDetailQuery(id),
    select: (data) => (data === null ? null : apiToTournament(data)),
  })
}

/** The current tournament's table catalogue, as prototype `TournamentTable[]`.
 * The API stores the full catalogue on the tournament, so this is the detail
 * query's `table_catalogue` (its shape already matches the prototype). Reads
 * the same cache entry as `useTournament`. */
export function useTables(id: string): TournamentTable[] {
  const { data } = useQuery({
    ...tournamentDetailQuery(id),
    select: (data) => data?.table_catalogue ?? [],
  })
  return data ?? []
}

// ----- mutations -----------------------------------------------------------

/** Create a bare tournament. Returns the created id for navigation.
 *
 * No global `onError` toast: `NewTournamentModal` awaits this via `mutateAsync`
 * and surfaces a 4xx inline on the name field (and toasts the rest itself), so
 * a global toast here would double up. (Same convention as the RBAC form
 * mutations — see `rbac/queries.ts`.) */
export function useCreateTournament() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: TournamentCreate): Promise<TournamentRead> =>
      unwrap('create tournament', await api.POST('/v1/tournaments', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: TOURNAMENTS_KEY }),
  })
}

/** Patch tournament-level fields (name/status/dates/description/address/
 * table_catalogue) — never events. */
export function useUpdateTournament() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      patch: TournamentUpdate
    }): Promise<TournamentRead> =>
      unwrap(
        'update tournament',
        await api.PATCH('/v1/tournaments/{tournament_id}', {
          params: { path: { tournament_id: input.id } },
          body: input.patch,
        }),
      ),
    onSuccess: (_data, input) => invalidateTournament(qc, input.id),
    onError: notifyError('update the tournament'),
  })
}

export function useDeleteTournament() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        'delete tournament',
        await api.DELETE('/v1/tournaments/{tournament_id}', {
          params: { path: { tournament_id: id } },
        }),
        { allowEmpty: true },
      )
    },
    onSuccess: (_data, id) => invalidateTournament(qc, id),
    onError: notifyError('delete the tournament'),
  })
}

export function useCreateEvent(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: TournamentEventCreate): Promise<TournamentEventRead> =>
      unwrap(
        'create event',
        await api.POST('/v1/tournaments/{tournament_id}/events', {
          params: { path: { tournament_id: tournamentId } },
          body,
        }),
      ),
    onSuccess: () => invalidateTournament(qc, tournamentId),
    onError: notifyError('create the event'),
  })
}

export function useUpdateEvent(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      eventId: string
      body: TournamentEventUpdate
    }): Promise<TournamentEventRead> =>
      unwrap(
        'update event',
        await api.PATCH('/v1/tournaments/{tournament_id}/events/{event_id}', {
          params: { path: { tournament_id: tournamentId, event_id: input.eventId } },
          body: input.body,
        }),
      ),
    onSuccess: () => invalidateTournament(qc, tournamentId),
    onError: notifyError('update the event'),
  })
}

export function useDeleteEvent(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (eventId: string) => {
      unwrap(
        'delete event',
        await api.DELETE('/v1/tournaments/{tournament_id}/events/{event_id}', {
          params: { path: { tournament_id: tournamentId, event_id: eventId } },
        }),
        { allowEmpty: true },
      )
    },
    onSuccess: () => invalidateTournament(qc, tournamentId),
    onError: notifyError('delete the event'),
  })
}

// ----- entries (self-registration, ADR-0016) -------------------------------
//
// Entrants arrive nested in the tournament detail/list payloads, so entering and
// withdrawing need no query of their own — they invalidate the tournament (list
// + detail), and the refetched event carries both the updated `entrants` list
// and the derived `entered` count. That is the whole invalidation set: the two
// keys `invalidateTournament` already covers.
//
// Both mutations invalidate **`onSettled`, not `onSuccess`** — they reconcile
// whether they succeeded or failed. A failed entry is precisely the moment the
// screen is most likely to be lying: the 409 the server answers means "your view
// and my state disagree" (someone — usually you, in another tab — already entered
// you), so the only sane response is to re-read the server. Invalidating only on
// success left the stale tab frozen on `0 / 64` + **Enter** + "No one has entered
// yet" after the very request that proved all three wrong (#943). Withdraw's
// stale-tab race happens to land on its *success* path (a repeat withdrawal is an
// idempotent 204), so it looked fine — but that was luck, not design; it settles
// into the same reconcile here on purpose.

/** True for the entry endpoint's "You have already entered this event." — the
 * only 409 `POST …/entries` raises (its partial unique index on the *active*
 * entries; see `enter_event` in `api/app/tournaments.py`). It is not really a
 * failure: it means the player IS entered, so the reconciled view is the answer,
 * and shouting a red error over a screen that now says "Withdraw" would be the
 * lie. Anything else — 400, 403, 5xx, network-down — is a genuine error and still
 * toasts. */
function isAlreadyEntered(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
}

/** Enter the *signed-in* player into an event. There is no request body — the
 * caller is the entrant (self-registration; a director entering someone else is
 * a separate, later endpoint). Resolves to the created `Entrant`, whose `id` is
 * the entry id a later withdrawal is addressed to.
 *
 * A non-singles event is a 400 and surfaces as an error toast. A duplicate entry
 * is a 409, which is treated as *benign*: the tournament is re-read (as on every
 * settle) and the player gets a quiet, informational "you were already entered"
 * note over the now-truthful card, not an error. A caller that wants to handle
 * the 409 itself can still await `mutateAsync` and inspect the `ApiError`. */
export function useEnterEvent(tournamentId: string) {
  const qc = useQueryClient()
  const toastError = notifyError('enter the event')
  return useMutation({
    mutationFn: async (eventId: string): Promise<Entrant> => {
      const entrant = unwrap(
        'enter event',
        await api.POST(
          '/v1/tournaments/{tournament_id}/events/{event_id}/entries',
          {
            params: {
              path: { tournament_id: tournamentId, event_id: eventId },
            },
          },
        ),
      )
      return apiToEntrant(entrant)
    },
    // Reconcile on BOTH paths — see the note above.
    onSettled: () => invalidateTournament(qc, tournamentId),
    onError: (error) => {
      if (isAlreadyEntered(error)) {
        toast.info('You were already entered in this event', {
          description: "We've refreshed it with the latest entries.",
        })
        return
      }
      toastError(error)
    },
  })
}

/** Withdraw one of the signed-in player's own entries (a soft-delete on the
 * server: the entry survives as history, and the player may enter again). Keyed
 * by the ENTRY's id — take it from the entrant in the event's `entrants` list.
 * Repeating a withdrawal is a no-op, not an error. */
export function useWithdrawEntry(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { eventId: string; entryId: string }) => {
      unwrap(
        'withdraw from event',
        await api.DELETE(
          '/v1/tournaments/{tournament_id}/events/{event_id}/entries/{entry_id}',
          {
            params: {
              path: {
                tournament_id: tournamentId,
                event_id: input.eventId,
                entry_id: input.entryId,
              },
            },
          },
        ),
        { allowEmpty: true },
      )
    },
    // Reconcile on BOTH paths — see the note above. A failed withdrawal (a 403 on
    // an entry that is no longer mine, a 404 on one the server has re-keyed) is a
    // view/state disagreement just like the entry 409 is.
    onSettled: () => invalidateTournament(qc, tournamentId),
    onError: notifyError('withdraw from the event'),
  })
}
