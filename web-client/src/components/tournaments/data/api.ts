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
import { notFound } from '@tanstack/react-router'
import { toast } from 'sonner'

import { ApiError, api, unwrap } from '@/api/client'
import { notifyError } from '@/lib/notify-error'
import type { components } from '@/api/schema'
import { entryRefusalNotice } from './entry-refusal'
import { parseFixtures } from './fixtures'
import { parseResults } from './results'
import {
  parseLatestScheduleSolve,
  parseScheduleSolve,
  scheduleRefetchInterval,
  type ScheduleSolve,
} from './solve'
import type { LifecycleEdge } from './lifecycle'
import type {
  Address,
  Entrant,
  EventEntryState,
  Fixture,
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
type AddressInput = components['schemas']['AddressInput']
type TournamentEventCreate = components['schemas']['TournamentEventCreate']
type TournamentEventUpdate = components['schemas']['TournamentEventUpdate']
type ApiPool = components['schemas']['Pool']
type ApiPredicate = components['schemas']['Predicate']
type ApiEntryState = TournamentEventRead['entry_state']
type TournamentFixturePlacementUpdate =
  components['schemas']['TournamentFixturePlacementUpdate']

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

/** Map the event's server-computed entry judgement (`entry_state`, ADR-0783) onto
 * the domain union. The `state` tags are carried across **unchanged** — they are
 * the entry refusal codes (ADR-0968), so the reason the page load gives and the
 * reason a 409 gives share one copy table (`./entry-refusal`). Renaming them here
 * would fork that table in two.
 *
 * The `default` arm is not dead code, however much the generated types say it is:
 * the wire is untrusted, and a `state` from a schema that is not ours must not
 * reach a component whose `switch` would fall through it. It degrades to `open` —
 * the server is the authority on entry, and it refuses the click with a coded 409
 * this client already has words for. */
export function apiToEntryState(s: ApiEntryState): EventEntryState {
  switch (s.state) {
    case 'open':
    case 'event_full':
      return { state: s.state }
    case 'rating_ineligible':
      return {
        state: s.state,
        predicateId: s.predicate_id,
        rating: s.rating,
      }
    default: {
      // A state added to the API and not yet to this client is a COMPILE error
      // here — and, at runtime, a degrade rather than an unrenderable card.
      const exhaustive: never = s
      void exhaustive
      return { state: 'open' }
    }
  }
}

// ----- adapters: API (snake_case) <-> prototype (camelCase) ----------------

/** Map an API entrant to the prototype's `Entrant`.
 *
 * `rating` is carried across **unchanged, `null` included**: it is the entrant's
 * rating on the tournament's ladder as the *server* resolved it (ADR-0783), and a
 * `null` means unrated — not "missing", not "0", and emphatically not a value to
 * coalesce. Defaulting it to a number here would erase the one fact this field
 * exists to carry. */
export function apiToEntrant(e: TournamentEntrantRead): Entrant {
  return {
    id: e.id,
    userId: e.user_id,
    username: e.username,
    seed: e.seed,
    rating: e.rating,
  }
}

/** Map an API event payload to the prototype's `TournamentEvent`. `entered`
 * comes straight off the wire: the server derives it from the same active
 * entries it lists in `entrants`, so the two always agree. So does
 * `entry_state` — whether this event has room for the caller, and whether their
 * rating satisfies its rules, is the server's judgement and never the client's
 * (ADR-0783). */
export function apiToEvent(e: TournamentEventRead): TournamentEvent {
  return {
    id: e.id,
    name: e.name,
    format: e.format,
    drawType: e.draw_type,
    maxPlayers: e.max_players,
    entryFee: e.entry_fee,
    timezone: e.timezone,
    entered: e.entered,
    entrants: e.entrants.map(apiToEntrant),
    entryState: apiToEntryState(e.entry_state),
    slot: e.slot,
    predicates: e.predicates.map(apiToPredicate),
    match: { rated: e.match_settings.rated, lengthGames: e.match_settings.length_games },
    pools: e.pools.map(apiToPool),
    // PARSED, not cast (`./fixtures`, `.claude/rules/parse-at-boundaries.md`). Every
    // other field above is mapped on the compiler's word that the payload matches
    // `schema.d.ts`; the draw is checked at RUNTIME, because it is the one structure on
    // this payload a renderer walks by shape — pool → round → position, sides that may
    // be null — so a malformed fixture would otherwise surface as an `undefined` in a
    // bracket cell, three components away from the response that carried it.
    //
    // Both callers of this mapper run inside a `queryFn` (see the queries below), so
    // the throw lands where a failed fetch lands: the query errors, the cache is never
    // primed with the bad payload, and the boundary renders. An event whose draw has
    // not been cut parses to `[]` — the designed empty state, not an error.
    fixtures: parseFixtures(e.fixtures),
    // PARSED, not cast — the same boundary the draw crosses (`./results`,
    // `.claude/rules/parse-at-boundaries.md`). Standings are the one other structure on
    // this payload a renderer walks by shape (a table of numbers, joined to names), so a
    // malformed row must fail HERE, inside the fetch, rather than surface as a `NaN` in a
    // cell. `null` is the designed "no results" state (an uncut or non-round-robin event),
    // and parses straight through to `null`.
    results: parseResults(e.results),
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
    // PARSED, not cast — the same boundary the fixtures and results cross
    // (`./solve`, `.claude/rules/parse-at-boundaries.md`): the solve strip switches
    // on this row's `status`/`trigger`/`verdict` by value, so an enum member this
    // client does not know must fail HERE, inside the queryFn, rather than fall out
    // of a `switch` as a blank strip. `null` — no solve ever requested — is the
    // designed state and parses straight through.
    latestScheduleSolve: parseLatestScheduleSolve(t.latest_schedule_solve),
  }
}

/** Project the read `Address` (which carries the server-geocoded
 * `latitude`/`longitude`) down to the coordinate-free `AddressInput` a write
 * verb sends. Coordinates are geocoded server-side at write time and a client
 * NEVER supplies them — the write schema is `extra="forbid"`, so sending them
 * would 422. Picking the six text fields keeps the write path coord-free no
 * matter what the read side accreted. */
function toAddressInput(a: Address): AddressInput {
  return {
    venue: a.venue,
    street: a.street,
    city: a.city,
    region: a.region,
    postal: a.postal,
    country: a.country,
  }
}

/** Build the `TournamentCreate` body from a prototype draft (the "New
 * tournament" modal). The modal collects no tables, so `table_catalogue` is the
 * empty array the bare-create endpoint expects.
 *
 * **No `status`.** A tournament is born `draft` — the server's column default
 * decides, the client does not ask (ADR-0017: status left the write schemas, so
 * the lifecycle only ever moves across a guarded edge). The draft the modal
 * hands us still carries a `status` because `Tournament` is the *read* model;
 * this builder simply does not propagate it. */
export function draftToCreateBody(
  draft: Omit<Tournament, 'id'>,
): TournamentCreate {
  return {
    name: draft.name,
    description: draft.description,
    start_date: draft.startDate,
    end_date: draft.endDate,
    address: toAddressInput(draft.address),
    table_catalogue: [],
  }
}

/** Build the tournament-level `TournamentUpdate` body from an edited prototype
 * `Tournament` and the full table catalogue. Events are NOT included — they
 * have their own endpoints. The catalogue is sent as-is (the Tables tab edits
 * it directly: assign IS catalogue here, since the API has no separate global
 * table list), so a Tables-tab edit round-trips the label/court, not just ids.
 *
 * **No `status`.** An edit carries no status, so editing a tournament's name or
 * dates can never move its lifecycle (ADR-0017). Moving it is
 * `POST /v1/tournaments/{id}/transitions`, which is a mutation of its own. */
export function tournamentToUpdateBody(
  t: Tournament,
  catalogue: TournamentTable[],
): TournamentUpdate {
  return {
    name: t.name,
    description: t.description,
    start_date: t.startDate,
    end_date: t.endDate,
    address: toAddressInput(t.address),
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
    timezone: ev.timezone,
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

/** What one tournament's detail fetch resolves to: the tournament in its domain shape,
 * plus the table catalogue the wire carries alongside it (the Tables tab edits the
 * catalogue itself — labels and courts, not just ids — so the domain `Tournament`'s
 * `tableIds` is not enough for it).
 *
 * The mapping runs in the `queryFn`, so what the CACHE holds is the parsed value, and
 * a payload the parse rejects never becomes one (`.claude/rules/parse-at-boundaries.md`
 * — "turn unstructured input into a trusted typed value once, at the edge"). It used to
 * run in each consumer's `select`, which looks equivalent and is not: TanStack Query
 * *catches* a throw from `select` and reports an error result while leaving the raw
 * payload sitting in `query.state.data` — so `throwOnError` (which asks whether there
 * is data) would answer "there is", swallow the throw, and the detail route, seeing an
 * undefined `data` that is not `isPending`, would render **"Tournament not found"** for
 * a tournament the server had just sent. A malformed draw must fail loudly, not quietly
 * turn a tournament into a 404. */
type TournamentDetail = {
  tournament: Tournament
  tables: TournamentTable[]
}

/** The detail query, shared by `useTournament` and `useTables` so both read one
 * cache entry from a single fetch — and one parse. It resolves to the mapped
 * `TournamentDetail`; each consumer selects its own projection.
 *
 * **A 404 is converted to a router `notFound()` right here, in the `queryFn`**
 * (ADR-1001: `docs/adr/1001-a-missing-resource-is-a-not-found-not-an-error.md`).
 * A missing tournament is not an error — it is a designed state — so it never
 * becomes an `ApiError` the error boundary sees. The throw lands in the detail
 * route's `notFoundComponent`, not its `errorComponent`. Two obligations follow,
 * both discharged on the route (`tournaments.$tournamentId.tsx`):
 *
 * - **the route must declare its own `notFoundComponent`.** A render-thrown
 *   `notFound` with no boundary of its own escapes to TanStack's generic
 *   "Something went wrong!" screen — `defaultNotFoundComponent` never sees it.
 * - **it must not be retried.** A 404 fails identically every time, so a retry
 *   only makes the user watch the skeleton longer before the not-found paints —
 *   see `retry` below.
 *
 * A 403 (a permitted non-creator the server still gates) is NOT converted: it
 * stays an `ApiError` and reaches the `RbacBoundary` the route wraps around
 * itself. Any other error throws too. */
function tournamentDetailQuery(id: string) {
  return queryOptions({
    queryKey: tournamentKey(id),
    queryFn: async (): Promise<TournamentDetail> => {
      let payload: TournamentDetailRead
      try {
        // The parse boundary: `apiToTournament` runs `parseFixtures` over every event's
        // draw, so a malformed fixture throws HERE — inside the fetch — and is reported
        // as a failed query rather than half-entering the app.
        payload = unwrap(
          'load tournament',
          await api.GET('/v1/tournaments/{tournament_id}', {
            params: { path: { tournament_id: id } },
          }),
        )
      } catch (error) {
        // The one status that is not an error. `notFound()` returns a plain object
        // (`{ isNotFound: true }`), NOT an `Error` — anything that can catch it must
        // tolerate a non-Error throw (the route's `RbacBoundary` narrows on
        // `instanceof ApiError`, so it does).
        if (error instanceof ApiError && error.status === 404) throw notFound()
        throw error
      }
      return {
        tournament: apiToTournament(payload),
        tables: payload.table_catalogue,
      }
    },
    // Throw on a first-load failure so it reaches a boundary — the converted 404
    // lands in the route's `notFoundComponent`, everything else (5xx, a 403, a
    // network blip, a malformed-draw parse) in its error boundary — but ONLY
    // while there is nothing on screen.
    //
    // `throwOnError` fires on *background refetch* failures too, not just the
    // first load. Since the entry mutations now reconcile on settle (see below),
    // a click during an outage would trigger a refetch that fails and throw the
    // whole rendered tournament away — a network blip on Enter is a toast, not a
    // teardown. With data in hand we keep the last-good view and let the
    // mutation's own error toast carry the failure.
    throwOnError: (_error, query) => query.state.data === undefined,
    // Decline to retry a terminal failure, retry a transient server one (ADR-1001).
    // A converted 404 (a `notFound()`), any other 4xx (a 403 included), and a parse
    // failure of an otherwise-OK payload all fail identically every time, so a retry
    // only delays the boundary. A genuine 5xx may clear, so give it a couple of
    // tries. Anything that is not an `ApiError` (a `notFound()`, a Zod parse throw)
    // is terminal here and declined.
    retry: (failureCount, error) => {
      if (!(error instanceof ApiError) || error.status < 500) return false
      return failureCount < 2
    },
  })
}

/** A single tournament's detail, as a prototype `Tournament`. A projection of the
 * parsed cache entry: the mapping already happened, in the `queryFn`. A 404 no
 * longer resolves to `null` here — it is converted to a router `notFound()` in the
 * `queryFn` (ADR-1001), which the detail route's `notFoundComponent` catches, so
 * this never has to model "missing" as a value. */
export function useTournament(id: string) {
  return useQuery({
    ...tournamentDetailQuery(id),
    select: (data) => data.tournament,
  })
}

/** The current tournament's table catalogue, as prototype `TournamentTable[]`.
 * The API stores the full catalogue on the tournament, so this is the detail
 * payload's `table_catalogue` (its shape already matches the prototype). Reads
 * the same cache entry — and the same single fetch — as `useTournament`. */
export function useTables(id: string): TournamentTable[] {
  const { data } = useQuery({
    ...tournamentDetailQuery(id),
    select: (data) => data.tables,
  })
  return data ?? []
}

// ----- mutations -----------------------------------------------------------
//
// INVALIDATION MAP — every mutation in this module invalidates exactly this set:
//
// | mutation                | invalidates                              | when      |
// | ----------------------- | ---------------------------------------- | --------- |
// | useCreateTournament     | ['tournaments']                          | onSuccess |
// | useUpdateTournament     | ['tournaments'], ['tournaments', id]     | onSuccess |
// | useTransitionTournament | ['tournaments'], ['tournaments', id]     | onSettled |
// | useDeleteTournament     | ['tournaments'], ['tournaments', id]     | onSuccess |
// | useCreateEvent          | ['tournaments'], ['tournaments', id]     | onSuccess |
// | useUpdateEvent          | ['tournaments'], ['tournaments', id]     | onSuccess |
// | useDeleteEvent          | ['tournaments'], ['tournaments', id]     | onSuccess |
// | useEnterEvent           | ['tournaments'], ['tournaments', id]     | onSettled |
// | useWithdrawEntry        | ['tournaments'], ['tournaments', id]     | onSettled |
// | useCutDraw              | ['tournaments'], ['tournaments', id]     | onSettled |
// | useUncutDraw            | ['tournaments'], ['tournaments', id]     | onSettled |
// | usePlaceFixture         | ['tournaments'], ['tournaments', id]     | onSettled |
// | useRequestScheduleSolve | ['tournaments'], ['tournaments', id]     | onSettled |
//
// There are only two keys, because there are only two queries: the list and one
// tournament's detail (events, entrants, the table catalogue AND every event's draw all
// arrive nested in the detail — see the queries above; there is deliberately no
// `GET …/draw`, because a per-event draw fetch would be an N+1 on the server and a
// suspense waterfall on the client, ADR-0786). Create is the one mutation that touches
// only the list: it has no detail entry to stale yet. The five `onSettled` rows
// reconcile on FAILURE as well as success, which is deliberate — see the notes on
// each.

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

/** Patch tournament-level fields (name/dates/description/address/
 * table_catalogue) — never events, and never `status` (ADR-0017: the lifecycle
 * moves only through `POST /v1/tournaments/{id}/transitions`). */
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

// ----- the lifecycle (ADR-0017) --------------------------------------------

/** Move a tournament along its lifecycle: `POST /v1/tournaments/{id}/transitions`
 * with the status to move **to**. This is the *only* way a status changes —
 * `TournamentUpdate` has no `status` field (ADR-0017), so the header's Publish /
 * Start / End buttons come here and nowhere else.
 *
 * The mutation's variable is the **edge** (`LIFECYCLE_EDGE`, `./lifecycle`), not a
 * bare target status, because the two things this needs — the `to` for the body and
 * the *verb* for a failure toast ("Couldn't publish the tournament", never
 * "Couldn't POST a transition") — are two facts about one edge. Taking the edge is
 * what lets there be ONE lifecycle table: a verb map keyed by target status would
 * be a second one, and would need an unreachable `draft` row to stay total.
 *
 * On the wire the caller sends only `to`: the tournament already knows where it is,
 * and a client that also sent `from` would only be reporting what it *believed* — a
 * stale tab's belief at that. Whether (current, `to`) is an edge at all is the
 * server's judgement, and an illegal one is a **409**.
 *
 * That 409 is a *genuine* failure — nothing moved — unlike the already-entered 409
 * below (which means "you are already in", and is benign). It reconciles
 * **`onSettled`, not `onSuccess`**, like the entry and draw mutations: a 409 means this
 * view and the server's state disagree — either the tournament moved on in another tab,
 * or (going live) its draws are not what this page last read — so re-reading it is what
 * corrects the badge and swaps the button for the one that *is* legal now. Invalidating
 * on success only would leave the stale tab offering the very button it was just refused.
 *
 * **No global `onError` toast**, by the convention the draw and event mutations already
 * follow (`web-client/CLAUDE.md`, ## Forms: a mutation whose errors are surfaced inline
 * must not also toast, or the user is told twice). `LifecycleActions` awaits this through
 * `mutateAsync` and renders every refusal **inline, beside the button**, in the words
 * `./lifecycle` owns — carrying the server's own sentence for the 409, which is the one
 * that names what the director has to go and fix (ADR-0786: the events with no draw, or
 * with a stale one). A toast would tell them the same thing twice and then take the work
 * list away after four seconds. */
export function useTransitionTournament(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (edge: LifecycleEdge): Promise<TournamentRead> =>
      unwrap(
        'move the tournament',
        await api.POST('/v1/tournaments/{tournament_id}/transitions', {
          params: { path: { tournament_id: tournamentId } },
          body: { to: edge.to },
        }),
      ),
    // Reconcile on BOTH paths — the 409 IS the stale-view signal.
    onSettled: () => invalidateTournament(qc, tournamentId),
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

/** Create an event.
 *
 * **No global `onError` toast**, by the same convention `useCreateTournament`
 * follows (#933, #934): the `EventEditor` awaits this through `mutateAsync` and
 * surfaces the failure *inside the sheet it keeps open* — which is the only place
 * that can also say "your changes are still here". A toast on top of that would
 * double up, and would be the wrong channel besides: it leaves after four seconds,
 * and the thing it is reporting (unsaved work) does not. (`CLAUDE.md`, `## Forms`:
 * "don't attach a global onError toast to a mutation a form surfaces inline".) */
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
  })
}

/** Patch an event. Errors are the editor's to show — no global `onError` toast;
 * it surfaces the failure inline and keeps the panel open (#933, #934). See
 * `useCreateEvent`. */
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
// screen is most likely to be lying: a 409 the server answers means "your view and
// my state disagree" — either someone (usually you, in another tab) already entered
// you, or the director moved the tournament on and the window is shut (ADR-0017) —
// so the only sane response is to re-read the server. Invalidating only on
// success left the stale tab frozen on `0 / 64` + **Enter** + "No one has entered
// yet" after the very request that proved all three wrong (#943). Withdraw's
// stale-tab race happens to land on its *success* path (a repeat withdrawal is an
// idempotent 204), so it looked fine — but that was luck, not design; it settles
// into the same reconcile here on purpose.

/** Enter the *signed-in* player into an event. There is no request body — the
 * caller is the entrant (self-registration; a director entering someone else is
 * a separate, later endpoint). Resolves to the created `Entrant`, whose `id` is
 * the entry id a later withdrawal is addressed to.
 *
 * **Every refusal is a 409 carrying a machine-readable `code`** (ADR-0968), and
 * `entryRefusalNotice` (`./entry-refusal`) turns the code into the client's own
 * copy — the two we know today being opposite news:
 *
 * - a **duplicate** entry (`already_entered`) is *benign* — the tournament is
 *   re-read (as on every settle) and the player gets a quiet, informational "you
 *   were already entered" note over the now-truthful card, not an error;
 * - a **closed window** (`registration_closed`) is a genuine refusal — the player
 *   is not entered and, from this page, cannot be. The error says so, while the
 *   same reconcile swaps the Enter button they clicked for the locked notice that
 *   is now true.
 *
 * Everything else — a 400, a 403, a 5xx, a network failure, and a 409 whose code
 * this client has no copy for — takes the ordinary error toast, which carries the
 * server's own message. That fallback is the honest degrade, and it replaces the
 * old fall-through that read every unrecognised 409 as a closed window.
 *
 * A caller that wants to handle a refusal itself can still await `mutateAsync` and
 * inspect the `ApiError`. */
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
      const notice = entryRefusalNotice(error)
      // Not a refusal we have words for: the server's message is the fallback
      // (ADR-0968), which `notifyError` puts in the toast's description.
      if (notice === null) {
        toastError(error)
        return
      }
      const ring = notice.tone === 'info' ? toast.info : toast.error
      ring(notice.title, { description: notice.description })
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

// ----- the draw (ADR-0786) -------------------------------------------------
//
// Two verbs, and NO query of their own. An event's fixtures ride the tournament detail
// payload it already fetches (`event.fixtures`), so cutting and un-cutting invalidate
// the tournament — list + detail — and the refetched event carries the new draw. That
// is the whole invalidation set: the same two keys `invalidateTournament` already
// covers. A `GET …/draw` per event would be an N+1 on the server and a suspense
// waterfall on the page, which is exactly why the API does not offer one.
//
// Both reconcile **`onSettled`, not `onSuccess`**, like the entry and lifecycle
// mutations and for the same reason: their most interesting failure is the one that
// says *this screen is stale*. A cut is refused with a **409** when the draw shows
// evidence of play (a fixture has a winner, or has become a real match) — which cannot
// be true of the draw this page is looking at, or it would not have offered the button.
// Something happened that this tab has not read yet, so the only sane response is to
// re-read the server: invalidating on success only would leave the director staring at
// the same Re-cut button that was just refused. The 403 (not the owner) and the 422
// (this event cannot be planned) are not stale-view failures, and re-reading is merely
// harmless for them — one rule for both verbs beats two rules that could disagree.

/** Cut (or **re-cut**) an event's draw: `POST …/events/{event_id}/draw`. Owner-only.
 * Resolves to the created fixtures, parsed (`./fixtures`) — the same list the next read
 * of the tournament will carry, in the same pool → round → position order.
 *
 * A re-cut **replaces the draw wholesale**: the old fixtures are deleted and a fresh set
 * is planned from the event's *current* active entrants, so their ids do not survive.
 * Nothing here is optimistic for that reason — there is no local edit to apply, only a
 * new draw to read back.
 *
 * The three refusals, all of which the server owns and this client merely reports:
 * - **403** — not the owner. The UI does not offer the verb to a non-owner, so this can
 *   only mean the page is looking at somebody else's tournament.
 * - **409** — the draw shows evidence of play; it can no longer be cut or removed.
 * - **422** — this event cannot be planned as it stands: an unsupported draw type (only
 *   round-robin has a generator today), no pools configured, or a field too small for
 *   the pools it has. The server's sentence names what the director must change, which
 *   is why it is a sentence and not a code.
 *
 * **No global `onError` toast**, by the same convention `useCreateEvent` and
 * `useUpdateEvent` follow: the `DrawPanel` awaits this through `mutateAsync` and renders
 * every refusal **inline, on the event's card** — where the button was, in the words
 * `data/draw.ts` owns, carrying the server's own sentence for the 409 and the 422. A
 * toast on top of that would tell the director the same thing twice, and would be the
 * wrong channel besides: it leaves after four seconds, and the sentence it carries is
 * the one they have to act on (`web-client/CLAUDE.md`, ## Forms: "don't attach a global
 * onError toast to a mutation a form surfaces inline"). */
export function useCutDraw(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (eventId: string): Promise<Fixture[]> => {
      const fixtures = unwrap(
        'cut the draw',
        await api.POST(
          '/v1/tournaments/{tournament_id}/events/{event_id}/draw',
          {
            params: {
              path: { tournament_id: tournamentId, event_id: eventId },
            },
          },
        ),
      )
      // The response is untrusted like every other payload — parse it, don't cast it.
      // This is also what stops a bad cut from priming the caller with half a draw.
      return parseFixtures(fixtures)
    },
    // Reconcile on BOTH paths — see the note above.
    onSettled: () => invalidateTournament(qc, tournamentId),
  })
}

/** Un-cut an event's draw: `DELETE …/events/{event_id}/draw`. Owner-only, and a **204**
 * with no body.
 *
 * The way back from a draw the director does not want — the event, its entrants and the
 * rest of the tournament are untouched, only the fixtures go, and the pool set unfreezes
 * so the pools can be edited before cutting again.
 *
 * **Idempotent**: removing a draw that was never cut is a 204, not a 404 (this is a
 * DELETE, and an event with no draw is already in the state it asks for). The one
 * refusal is the same **409** the cut has — a draw with evidence of play cannot be
 * removed, because the results on it would go with it.
 *
 * **No global `onError` toast**, for the reason given on `useCutDraw`: the `DrawPanel`
 * surfaces the refusal inline, and a toast would double it up. */
export function useUncutDraw(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (eventId: string) => {
      unwrap(
        'remove the draw',
        await api.DELETE(
          '/v1/tournaments/{tournament_id}/events/{event_id}/draw',
          {
            params: {
              path: { tournament_id: tournamentId, event_id: eventId },
            },
          },
        ),
        { allowEmpty: true },
      )
    },
    // Reconcile on BOTH paths — see the note above.
    onSettled: () => invalidateTournament(qc, tournamentId),
  })
}

// ----- the schedule (ADR-0790) ---------------------------------------------
//
// A **placement** is a fixture's table + predicted start (ADR-0790). Like the draw
// verbs, it has NO query of its own — the fixture's `table_id` / `scheduled_start` ride
// the tournament detail payload the Schedule tab already reads (`event.fixtures`), so a
// placement invalidates the tournament (list + detail) and the refetched fixture carries
// the new table/time. That is the whole invalidation set: the same two keys
// `invalidateTournament` covers, no schedule query to add.

/** Set (or clear) a fixture's **placement**: `PATCH …/fixtures/{fixture_id}/placement`
 * with the table and predicted start in full (ADR-0790). Owner-only.
 *
 * The body is the placement whole — `table_id` + `scheduled_start`, both required, and
 * **`null` on either clears that half** (`(null, null)` unassigns the fixture). The
 * server stores it soft: an out-of-window time or a `table_id` that names no catalogue
 * table is saved, not refused (those are flags-on-read, a later scheduler slice). The one
 * refusal is a **409** on a fixture whose match is `completed`/`voided` — its placement is
 * history. The Schedule tab does not offer the control for a finished match, so the 409
 * only surfaces on a lost race; the toast carries the server's word for it.
 *
 * Reconciles **`onSettled`** — the placement re-renders from the refetched tournament,
 * never from an optimistic local write, so what the grid shows is always the server's. */
export function usePlaceFixture(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      fixtureId: string
      body: TournamentFixturePlacementUpdate
    }): Promise<Fixture> => {
      const fixture = unwrap(
        'place the match',
        await api.PATCH(
          '/v1/tournaments/{tournament_id}/fixtures/{fixture_id}/placement',
          {
            params: {
              path: { tournament_id: tournamentId, fixture_id: input.fixtureId },
            },
            body: input.body,
          },
        ),
      )
      // The response is untrusted like every other payload — parse it, don't cast it.
      return parseFixtures([fixture])[0]
    },
    onSettled: () => invalidateTournament(qc, tournamentId),
    onError: notifyError('place the match'),
  })
}

// ----- the schedule solver (ADR "the schedule is solved; the call is pinned") ----
//
// One verb and NO query of its own: `POST …/schedule/solves` queues a run, and the
// run's *outcome* rides the tournament detail payload the Schedule tab already reads
// (`latest_schedule_solve`, plus each fixture's refreshed placement) — one BFF
// endpoint per page, so the invalidation set is the same two keys
// `invalidateTournament` already covers. Freshness between mutations is POLLING
// (`useSchedulePolling` below): the solver runs on a worker, behind this page's
// back, and its finish is not an event this client is told about.

/**
 * Request a run of the schedule solver — the owner's **Run scheduler** button:
 * `POST /v1/tournaments/{id}/schedule/solves`, no body. Owner-only.
 *
 * The **202** is a request accepted, not work done: one solve is in flight per
 * tournament, so a click while one is `queued` is absorbed by it (the same ledger
 * row comes back) and a click while one is `running` flags a re-run. Either way the
 * honest next step is to re-read the tournament — which `onSettled` does — and let
 * the strip render the row the detail now carries; the in-flight poll
 * (`useSchedulePolling`) then carries it to its outcome.
 *
 * Reconciles **`onSettled`, not `onSuccess`**, like the draw and placement
 * mutations: the interesting failure says *this view is stale* — the 422
 * (`no_drawn_events`) means the draws this page shows are not the draws the server
 * holds (someone un-cut them), and re-reading is what corrects the tab.
 *
 * **No global `onError` toast**, by the `useCutDraw` convention: the solve strip
 * awaits this through `mutateAsync` and renders every refusal **inline, on the
 * strip**, in the words `./solve` owns (`runSchedulerNotice`) — the 422 "cut a draw
 * first" is a designed state there, not an error channel's business.
 */
export function useRequestScheduleSolve(tournamentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<ScheduleSolve> => {
      const row = unwrap(
        'run the scheduler',
        await api.POST('/v1/tournaments/{tournament_id}/schedule/solves', {
          params: { path: { tournament_id: tournamentId } },
        }),
      )
      // The response is untrusted like every other payload — parse it, don't cast it.
      return parseScheduleSolve(row)
    },
    // Reconcile on BOTH paths — see the note above.
    onSettled: () => invalidateTournament(qc, tournamentId),
  })
}

/**
 * Keep the tournament detail fresh while the Schedule tab is on screen — a
 * subscription to the SAME cache entry every other consumer reads (same key, same
 * `queryFn`, one fetch), whose only contribution is a `refetchInterval`.
 *
 * The cadence is `scheduleRefetchInterval` (`./solve`, pure and unit-tested):
 * ~3s while a solve is in flight (whatever the status — the director who clicked
 * Run is watching the strip), ~15s while the tournament is `live` (completions
 * re-plan the schedule behind this page's back), and none otherwise.
 *
 * Mounted by the Schedule tab alone, so the poll lives exactly as long as the tab
 * is the active one (an inactive tab's content is unmounted) — the rest of the
 * detail page never polls. `notifyOnChangeProps: []` keeps the subscription
 * render-silent: the tab re-renders through the `useTournament` data it already
 * holds, not through this observer.
 */
export function useSchedulePolling(tournamentId: string): void {
  useQuery({
    ...tournamentDetailQuery(tournamentId),
    refetchInterval: (query) => {
      const detail = query.state.data
      return scheduleRefetchInterval(
        detail?.tournament.status,
        detail?.tournament.latestScheduleSolve ?? null,
      )
    },
    notifyOnChangeProps: [],
  })
}
