// Would a PENDING event edit newly strand an already-placed match against a
// reservation it is scheduled through (#1537)?
//
// The server computes two flags for the SAVED state on every fixture read
// (`fixtures.ts`'s `tableOffReservation` / `startOutsideReservationWindow`,
// `schema.d.ts`'s `TournamentFixtureRead` doc has the full rule). This module answers
// the question the server cannot yet: would the reservations a director is ABOUT to
// save — not sent yet — strand a match the server has not seen change? `EventEditor`'s
// confirmation is the one caller (`strand-confirm-dialog.tsx`).
//
// "Newly stranded, not still stranded" (the ticket's own phrase): a repeat save of an
// already-stranded match must not reopen the confirmation on every subsequent save. So
// a match counts only when the DRAFT flags it (`placementFlags` below, the SAME
// closed-interval boundary rule the server uses) AND the SAVED state does not — read
// directly off the fixture's own server-computed flags, the ground truth for "is this
// stranded right now" (see `newlyStrandedFixtures`'s own doc for why that arm is not a
// second client-side derivation of the same fact).
//
// Pure, so it is unit-tested (`./reservation-strand.test.ts`) rather than asserted
// through a DOM — the `./schedule.ts` stance.

import { fmtBoardClock, parseLocalLabel } from './timeline'
import type { Fixture, Group, ReservationEntry, Slot, TournamentEvent } from './types'

/** A resolved reservation's tables + window — whichever content wins the two-hop
 * lookup (a group's mapped reservation, or the event-wide fallback), the SAME shape
 * `fixtureReservation`/`toScheduleMatch` (`./draw`, `./schedule`) already produce for
 * the placement picker's suggestions. One shape lets `placementFlags` judge either a
 * DRAFT or a SAVED reservation without caring which. */
export interface ReservationContent {
  tableIds: string[]
  window: Slot
}

/** The client's mirror of the server's two per-fixture flags — same shape, same
 * boundary rule (`TournamentFixtureRead`'s doc, `schema.d.ts`). */
export interface PlacementFlags {
  tableOffReservation: boolean | null
  startOutsideReservationWindow: boolean | null
}

/**
 * The naive `YYYY-MM-DDTHH:MM` a placed fixture's predicted start reduces to, for
 * comparing against a reservation window's own naive bounds (`isWithinWindow` below) —
 * the same naive frame `composeScheduledStart` (`./schedule.ts`) writes a placement in.
 *
 * Reconstructed, not read off the wire: the server renders `scheduledStart` as a
 * `FixtureTime` (an instant + a venue-local `localLabel`, ADR "tournament times are
 * timezone-aware instants"), which carries no raw naive value for a client to read
 * back — and a client does not do timezone arithmetic to invent one (`CLAUDE.md`'s
 * stance: the server does every bit of the actual timezone math). What it DOES have,
 * with no tz conversion at all, is `localLabel`'s time-of-day (`parseLocalLabel` is a
 * string parse of what the server already rendered, not a conversion) and the
 * reservation's own `Slot.date` — a plain field the client already holds, never
 * derived — so pairing the two IS the naive value, for every fixture whose true stored
 * date has not itself already drifted from the window it currently resolves against
 * (the ordinary case). `newlyStrandedFixtures` below covers the one case this
 * reconstruction cannot see on its own — a date that already drifted from an EARLIER
 * edit — by also consulting the fixture's own server-computed flags.
 */
function resolvePlacedNaive(
  scheduledStart: Fixture['scheduledStart'],
  referenceDate: string,
): string | null {
  if (scheduledStart === null) return null
  return `${referenceDate}T${fmtBoardClock(parseLocalLabel(scheduledStart.localLabel))}`
}

/** One naive bound of a window (`start` or `end`), in the same `YYYY-MM-DDTHH:MM`
 * shape `resolvePlacedNaive` produces — so the two sides of every compare below are
 * byte-identical in format (no stray `:00` seconds on one side and not the other). */
function naiveBound(window: Slot, bound: 'start' | 'end'): string {
  return `${window.date}T${window[bound]}`
}

/** Is `naive` inside the reservation's window — a **closed interval**
 * `[window_start, window_end]`, a start landing exactly on either edge counting as
 * *inside* (the server's own rule, `schema.d.ts`'s `start_outside_reservation_window`
 * doc — a deliberate booking-semantics choice, NOT a mirror of `app.scheduling`'s
 * solver-grid window, which is a different, half-open thing for a different purpose).
 * `YYYY-MM-DDTHH:MM` strings compare correctly with plain `<=`/`>=`: ISO 8601's field
 * order is also lexicographic order. */
function isWithinWindow(naive: string, window: Slot): boolean {
  return naive >= naiveBound(window, 'start') && naive <= naiveBound(window, 'end')
}

/**
 * The client's mirror of the server's two per-fixture flags, for a placement +
 * reservation content the caller has already resolved (SAVED or DRAFT — this function
 * does not care which).
 *
 * `decided` mirrors the server's OTHER null condition (`completed`/`voided`): passed
 * in rather than read off a `matchStatus`, so this stays a placement-and-content
 * calculation with no fixture shape of its own to agree with the caller's.
 */
export function placementFlags(
  placement: { tableId: string | null; scheduledStartNaive: string | null },
  decided: boolean,
  reservation: ReservationContent,
): PlacementFlags {
  if (decided) {
    return { tableOffReservation: null, startOutsideReservationWindow: null }
  }
  return {
    tableOffReservation:
      placement.tableId === null
        ? null
        : !reservation.tableIds.includes(placement.tableId),
    startOutsideReservationWindow:
      placement.scheduledStartNaive === null
        ? null
        : !isWithinWindow(placement.scheduledStartNaive, reservation.window),
  }
}

/** A reservation as the two-hop lookup needs it — the fields `Reservation` (saved) and
 * a `kept` `ReservationEntry` (draft) both carry. */
interface ReservationLike {
  id: string
  tableIds: string[]
  slot: Slot
}

/** The two-hop lookup (`fixtureReservation`, `./draw`), re-run here rather than
 * imported: that version resolves against a `DrawIndex` built from a `TournamentEvent`,
 * and a DRAFT is not one — its `reservations` are a diff (`ReservationEntry[]`), not
 * `Reservation[]`. Both arms of this module's own compare go through this SAME
 * function instead, over whichever reservation list (saved or draft) the caller hands
 * it, so the resolution logic itself cannot drift between the two arms. */
function resolveContent(
  fixture: Pick<Fixture, 'groupId'>,
  groups: Group[],
  reservations: readonly ReservationLike[],
  eventSlot: Slot,
  tournamentTableIds: readonly string[],
): ReservationContent {
  const group = fixture.groupId !== null ? (groups.find((g) => g.id === fixture.groupId) ?? null) : null
  const reservation =
    group?.reservationId != null
      ? (reservations.find((r) => r.id === group.reservationId) ?? null)
      : null
  return reservation
    ? { tableIds: reservation.tableIds, window: reservation.slot }
    : { tableIds: [...tournamentTableIds], window: eventSlot }
}

/** One fixture this draft would newly strand. */
export interface StrandedFixture {
  fixtureId: string
  /** Whether this fixture was **called** (`pinnedAt` set) — the ticket's second
   * number: how many of the newly-stranded matches are a promise already made to
   * players, not just a placement. */
  called: boolean
}

/**
 * Every placed, undecided fixture of `event` that `draft` would newly strand —
 * flagged `true` against the pending reservations/slot, and NOT already true against
 * the event's currently-saved ones.
 *
 * "Not already true" reads the fixture's own server-computed flags
 * (`fixture.tableOffReservation` / `startOutsideReservationWindow`) directly, rather
 * than re-deriving the saved state client-side: those flags ARE the ground truth for
 * "is this fixture stranded right now", computed by the server from the exact
 * reservations `event` itself holds, so a second client-side derivation of the same
 * fact could only ever agree with them (drop) or disagree with them (be wrong). This
 * is also what keeps the one case this module's naive reconstruction
 * (`resolvePlacedNaive`) cannot see on its own — a fixture whose true stored date
 * already drifted from its currently-effective window because of an EARLIER edit that
 * was never re-placed — from mattering here: that reconstruction is used only for
 * `draftFlags` below, the one question with no server answer yet.
 *
 * `tournamentTableIds` is the tournament's whole table catalogue's ids — what an
 * un-grouped (event-wide) fixture may be placed on, the same fallback
 * `toScheduleMatch` (`./schedule`) uses.
 */
export function newlyStrandedFixtures(
  event: Pick<TournamentEvent, 'fixtures' | 'groups' | 'reservations' | 'slot'>,
  draft: { slot: Slot; reservations: ReservationEntry[] },
  tournamentTableIds: readonly string[],
): StrandedFixture[] {
  const draftReservations: ReservationLike[] = draft.reservations
    .filter((r): r is Extract<ReservationEntry, { kind: 'kept' }> => r.kind === 'kept')
    .map((r) => ({ id: r.id, tableIds: r.tableIds, slot: r.slot }))

  const stranded: StrandedFixture[] = []

  for (const fixture of event.fixtures) {
    const decided = fixture.matchStatus === 'completed' || fixture.matchStatus === 'voided'
    if (decided) continue
    if (fixture.tableId === null && fixture.scheduledStart === null) continue

    const savedContent = resolveContent(
      fixture,
      event.groups,
      event.reservations,
      event.slot,
      tournamentTableIds,
    )
    const draftContent = resolveContent(
      fixture,
      event.groups,
      draftReservations,
      draft.slot,
      tournamentTableIds,
    )

    const naive = resolvePlacedNaive(fixture.scheduledStart, savedContent.window.date)
    const placement = { tableId: fixture.tableId, scheduledStartNaive: naive }

    const draftFlags = placementFlags(placement, false, draftContent)

    const tableWasStranded = fixture.tableOffReservation === true
    const windowWasStranded = fixture.startOutsideReservationWindow === true

    const newlyStranded =
      (draftFlags.tableOffReservation === true && !tableWasStranded) ||
      (draftFlags.startOutsideReservationWindow === true && !windowWasStranded)

    if (newlyStranded) {
      stranded.push({ fixtureId: fixture.id, called: fixture.pinnedAt !== null })
    }
  }

  return stranded
}
