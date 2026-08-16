// An event's reservations as an **id-keyed diff** (ADR 20260801), on the client side
// of the wire: how the Reservations tab's edit is expressed, and how a reservation the
// director just added is told apart from one the server already holds.
//
// The twin of `./table-catalogue`, one resource over, and it exists for the same two
// server-side facts:
//
// 1. **The server mints reservation ids.** `ReservationWrite` is `extra="forbid"` and
//    has no `id` field, so a client-minted one is a 422 naming the entry. A new
//    reservation therefore carries no id at all — which is what `ReservationEntry`'s
//    `added` arm makes structurally true rather than a rule to remember (`./types`).
// 2. **An uncited stored reservation is removed**, and an entry citing an id the event
//    does not hold is a 422 on that entry (`['body','reservations',i,'id']`) — never a
//    quietly minted reservation, which would hand back a different id than was asked
//    for while removing the reservation the client meant to keep.
//
// There is no classifier here to match `tableInUseRefusal`: the one refusal a
// reservations edit can meet that a director may act on — the group-set freeze under a
// cut draw — is a 409 whose way out is "delete the draw", not "re-send with an opt-in".
// It is reported, in the server's own sentence, by the editor's failure banner
// (`./save-failure`).

import { genId } from './helpers'
import type { Reservation, ReservationDraft, ReservationEntry } from './types'

/** "Keep this reservation" — an entry citing a reservation the server actually sent
 * back. Built from the whole `Reservation`, so there is no way to cite an id that came
 * from anywhere but a read. */
export const keepReservation = (reservation: Reservation): ReservationEntry => ({
  kind: 'kept',
  id: reservation.id,
  name: reservation.name,
  slot: reservation.slot,
  tableIds: reservation.tableIds,
})

/** Every stored reservation, cited — the "change nothing about the set" list. The base
 * an edit is built by filtering, appending to, or re-wording; it is what
 * `eventToFormValues` (`../tournament-detail-page/event-form`) seeds the editor's field
 * array with, in position order. */
export const keepReservations = (
  reservations: readonly Reservation[],
): ReservationEntry[] => reservations.map(keepReservation)

/** "Add this reservation" — **no id**, because the client has none to give (ADR
 * 20260801).
 *
 * The `key` is a React key and only ever that (see `ReservationEntry`): the cards are
 * keyed on something stable so an in-place `update()` re-renders a card instead of
 * remounting it and dropping the director's cursor, and a reservation the server has
 * never seen has nothing else to be keyed on. It is not an id, is never sent, and
 * cannot be mistaken for one — the arm that has an id is a different arm. */
export const addedReservation = (draft: ReservationDraft): ReservationEntry => ({
  kind: 'added',
  key: genId('new-reservation'),
  ...draft,
})

/** What to key this entry's card — and its name error — on: the server's id for a
 * reservation that has one, the client-side card key for one that does not.
 *
 * Keyed rather than indexed because an index renumbers: remove the first of three
 * reservations and an index-keyed error message is suddenly red under the wrong box (a
 * bug this editor has already had once, `reservations-section.test.tsx`). */
export const reservationEntryKey = (entry: ReservationEntry): string =>
  entry.kind === 'kept' ? entry.id : entry.key
