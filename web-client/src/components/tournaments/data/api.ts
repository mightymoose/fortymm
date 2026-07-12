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
import { entryRefusalNotice } from './entry-refusal'
import type { LifecycleEdge } from './lifecycle'
import type {
  Entrant,
  EventEntryState,
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
type ApiEntryState = TournamentEventRead['entry_state']

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
    entered: e.entered,
    entrants: e.entrants.map(apiToEntrant),
    entryState: apiToEntryState(e.entry_state),
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
    address: draft.address,
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
//
// There are only two keys, because there are only two queries: the list and one
// tournament's detail (events, entrants and the table catalogue all arrive nested
// in the detail — see the queries above). Create is the one mutation that touches
// only the list: it has no detail entry to stale yet. The three `onSettled` rows
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
 * That 409 is a *genuine* failure — nothing moved — so it toasts, unlike the
 * already-entered 409 below (which means "you are already in", and is benign). But
 * like the entry mutations it reconciles **`onSettled`, not `onSuccess`**: since the
 * UI only ever offers the edge that is legal from the status it last read, a 409 can
 * only mean this view is stale (the classic case: publish in tab A, then click
 * Publish in tab B). Re-reading the tournament is what corrects the badge and
 * swaps the button for the one that *is* legal now — invalidating on success only
 * would leave the stale tab offering the very button it was just refused. */
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
    // The verb is the edge the user asked for, so the toast names their click.
    onError: (error, edge) => notifyError(edge.verb)(error),
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
