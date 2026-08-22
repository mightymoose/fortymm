// The **groups + reservations** boundary (ticket #1369: the wire and both clients now
// say group and reservation, where they once shared a single, overloaded name): where
// an event's two arrays — the competitive face and the venue face of what used to be
// one concept — stop being bytes off the wire and become typed domain values.
//
// Parsed TOGETHER, deliberately, rather than as two independent arrays: the one
// invariant that matters crosses both. Every group's NON-NULL `reservation_id` must
// name an entry of `reservations` — the API's `GroupRead` doc says the join row behind
// it is a real foreign key, so this is UNREACHABLE from a correct server. But
// "unreachable from a correct server" is exactly the class of bug
// `.claude/rules/parse-at-boundaries.md` exists to catch: a broken serializer that
// silently dropped a reservation would otherwise render a fixture's window from a
// reservation that silently isn't there (or throw a bare `TypeError` three components
// downstream), instead of failing loudly, here, at the fetch boundary.
//
// A NULL `reservation_id` is a different thing, and it is accepted (ticket #1387): the
// server materialises an `rr-then-ko` event's groups from its field and maps each onto
// a reservation by `position % reservation count`, so an event with no reservation
// holds groups with none. Such a group is a real, reachable domain state — it renders
// without a window and without tables (`fixtureReservation`, `./draw`, already
// tolerates the unresolved hop) — so it is neither dropped nor a parse failure.
//
// A fixture's own `group_id` is the mirror-image case, and deliberately NOT checked
// here: `./fixtures` parses it permissively (`z.string().nullable()`, no membership
// check), and `drawState` (`./draw`) renders a fixture whose `groupId` names no group in
// the ungrouped block rather than dropping it or refusing the payload — the domain
// genuinely allows a knockout fixture that names no group. Reject-unknown here and
// tolerate-unknown there are not in tension: one is a wire invariant the server
// guarantees and never violates; the other is a real, reachable domain state.

import { z } from 'zod'

import type { Group, Reservation } from './types'

const slotWireSchema = z.object({
  date: z.string(),
  start: z.string(),
  end: z.string(),
})

/** The wire shape (`GroupRead`): server-minted identity and order, plus which
 * reservation it plays under. No write shape — a client never authors a group. */
const groupWireSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  reservation_id: z.string().nullable(),
})

/** The wire shape (`Reservation`, the read model): everything a client wrote
 * (`ReservationWrite`), plus the server-owned `id` and `position`. */
const reservationWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slot: slotWireSchema,
  table_ids: z.array(z.string()),
  position: z.number().int(),
})

/**
 * Both arrays, parsed together and **cross-checked**: every group's non-null
 * `reservation_id` must name an entry of `reservations`. Unreachable from a correct
 * server (see the file header), so a payload that fails this is a broken serializer,
 * and refusing beats silently rendering a plausible-but-wrong window. A `null` is a
 * group that plays in no reservation, and passes.
 */
const groupsAndReservationsWireSchema = z
  .object({
    groups: z.array(groupWireSchema),
    reservations: z.array(reservationWireSchema),
  })
  .superRefine((value, ctx) => {
    const reservationIds = new Set(value.reservations.map((r) => r.id))
    value.groups.forEach((group, i) => {
      if (group.reservation_id !== null && !reservationIds.has(group.reservation_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['groups', i, 'reservation_id'],
          message:
            `Group at position ${group.position} names a reservation ` +
            `("${group.reservation_id}") this event's reservations do not list.`,
        })
      }
    })
  })
  .transform(
    (value): { groups: Group[]; reservations: Reservation[] } => ({
      groups: value.groups.map(
        (g): Group => ({
          id: g.id,
          position: g.position,
          reservationId: g.reservation_id,
        }),
      ),
      reservations: value.reservations.map(
        (r): Reservation => ({
          id: r.id,
          name: r.name,
          slot: r.slot,
          tableIds: r.table_ids,
          position: r.position,
        }),
      ),
    }),
  )

/**
 * Parse an event's `groups` + `reservations` off the wire, or throw.
 *
 * Takes `unknown` for both, deliberately — the `./fixtures` / `./results` discipline:
 * the generated `schema.d.ts` types are a *compile-time* claim about what the server
 * sends, and this is the *runtime* guarantee. Called from `apiToEvent` (`./api`), so a
 * payload that fails the cross-check fails the *query* — the error boundary gets it,
 * and the cache is never primed with a group whose reservation cannot be found.
 *
 * Throws a `ZodError`, including for the cross-check failure.
 */
export function parseGroupsAndReservations(
  groups: unknown,
  reservations: unknown,
): { groups: Group[]; reservations: Reservation[] } {
  return groupsAndReservationsWireSchema.parse({ groups, reservations })
}
