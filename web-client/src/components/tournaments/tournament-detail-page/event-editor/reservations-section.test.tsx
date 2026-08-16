import userEvent from '@testing-library/user-event'

import { fireEvent, screen } from '@/test/utilities'

import { reservationEntryKey } from '../../data/reservation-entries'
import {
  buildDrawnEvent,
  buildEvent,
  buildFixture,
  buildReservation,
  buildTenReservations,
  TEN_RESERVATIONS_BY_ID,
  TEN_RESERVATIONS_BY_POSITION,
} from '../../data/seed.factory'
import { reservationsSectionPage } from './reservations-section.page'

/** An event with a **cut draw** and exactly one reservation — so the card-scoped queries
 * (`getTableToggle`, `getNameInput`) address one card rather than throwing on two.
 * A single fixture is a draw: the freeze turns on the draw *existing*, not on its
 * size (ADR-0786). */
const drawnOneReservationEvent = () =>
  buildEvent({
    reservations: [buildReservation({ id: 'p-1' })],
    fixtures: [buildFixture({ groupId: 'p-1' })],
  })

/** A morning reservation and an afternoon reservation — what a viewer actually reads. */
const twoReservations = () => [
  buildReservation({
    id: 'p-1',
    name: 'Reservation A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
    tableIds: ['t1', 't2'],
    position: 0,
  }),
  buildReservation({
    id: 'p-2',
    name: 'Reservation B',
    slot: { date: '2026-06-13', start: '13:00', end: '17:00' },
    tableIds: ['t3'],
    position: 1,
  }),
]

/** Two *overlapping* reservations sharing table t1 — a double-booking, the state that
 * raises the conflict Alert. */
const conflictingReservations = () => [
  buildReservation({
    id: 'a',
    name: 'Reservation A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:00' },
    tableIds: ['t1'],
    position: 0,
  }),
  buildReservation({
    id: 'b',
    name: 'Reservation B',
    slot: { date: '2026-06-13', start: '11:00', end: '14:00' },
    tableIds: ['t1'],
    position: 1,
  }),
]

describe('ReservationsSection', () => {
  // The three mutations, each asserted against the live form state the section
  // now drives via `useFieldArray` (chore 1e) — not a bridged `onChange` spy.
  describe('the reservation list drives the form', () => {
    it('appends a reservation to the form when Add reservation is clicked', async () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: [buildReservation()] }) })
      await userEvent.click(reservationsSectionPage.getAddReservationButton())
      expect(reservationsSectionPage.getReservations()).toHaveLength(2)
    })

    it('writes an edited table selection into the form', async () => {
      // The seeded reservation reserves t1–t4; toggling T5 must land in form state.
      reservationsSectionPage.render({
        event: buildEvent({ reservations: [buildReservation({ tableIds: ['t1'] })] }),
      })

      await userEvent.click(reservationsSectionPage.getTableToggle('T5'))
      expect(reservationsSectionPage.getReservations()[0].tableIds).toEqual(['t1', 't5'])
    })

    it('removes a reservation from the form', async () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: twoReservations() }) })
      expect(reservationsSectionPage.getReservations()).toHaveLength(2)

      // Remove the first reservation; the second must be what survives.
      await userEvent.click(reservationsSectionPage.getRemoveReservationButtons()[0])
      const remaining = reservationsSectionPage.getReservations()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ kind: 'kept', id: 'p-2' })
    })
  })

  /**
   * **Ten reservations read 1 … 10** — the claim `Reservation.position` was added to make.
   *
   * The fixture (`buildTenReservations`) hands the section its reservations in the order a sort by ID
   * would produce, because a sorted fixture cannot falsify anything: it would pass just
   * as happily against a section that trusted the array it was given, and against one
   * that sorted by id. Here both of those render `Reservation 1, Reservation 10, Reservation 2 …`, which is
   * the real ten-reservation bug, spelled out in the guard below.
   */
  describe('ten reservations, in position order', () => {
    // The fixture's own shape, asserted rather than assumed — if this ever stops being
    // the id order, every claim below quietly stops discriminating.
    it('is built from a fixture whose id order is the WRONG order', () => {
      expect(TEN_RESERVATIONS_BY_ID).toEqual([
        'Reservation 1',
        'Reservation 10',
        'Reservation 2',
        'Reservation 3',
        'Reservation 4',
        'Reservation 5',
        'Reservation 6',
        'Reservation 7',
        'Reservation 8',
        'Reservation 9',
      ])
      expect(TEN_RESERVATIONS_BY_ID).not.toEqual(TEN_RESERVATIONS_BY_POSITION)
    })

    it('renders the cards in position order, not in id order', () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: buildTenReservations() }) })

      expect(reservationsSectionPage.getReservationNames()).toEqual(TEN_RESERVATIONS_BY_POSITION)
    })

    // …and the same for a reader, whose cards are text rather than boxes (ADR-0015).
    it('reads back in position order for a viewer too', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: buildTenReservations() }),
        canEdit: false,
      })

      expect(reservationsSectionPage.getReservationNames()).toEqual(TEN_RESERVATIONS_BY_POSITION)
    })

    /**
     * The order the cards are in is the order the FORM is in — which matters because the
     * form array is what a save serializes, and the server re-derives each position from
     * that array's index. A section that sorted only its render would round-trip the
     * director's reservations into a different order than the one they were looking at.
     */
    it('seeds the form array in position order, so the save sends that order', () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: buildTenReservations() }) })

      expect(reservationsSectionPage.getReservations().map((p) => p.name)).toEqual(
        TEN_RESERVATIONS_BY_POSITION,
      )
      // …and every one of them CITES the id the server minted (ADR 20260801). An entry
      // that arrived as an `added` would be an insert, and the reservation it stopped citing a
      // removal — a no-op edit that silently replaced ten reservations with ten new ones and
      // took the draw dealt across them with it.
      expect(reservationsSectionPage.getReservations().map((p) => p.kind)).toEqual(
        Array(10).fill('kept'),
      )
      expect(reservationsSectionPage.getReservations().map((p) => reservationEntryKey(p))).toEqual(
        buildTenReservations()
          .sort((a, b) => a.position - b.position)
          .map((p) => p.id),
      )
    })

    /**
     * **The order is now the only thing that says where a reservation sits**, so a reservation added
     * at the end has to *be* at the end: the server derives each position from the index
     * of the entry in the list it is sent (`ReservationWrite` has no `position` — sending one is
     * a 422 naming the field), and the array the editor serializes is this one.
     *
     * Ten reservations, so "last" cannot be confused with anything else, and the removal case
     * below is the one the old client-side position arithmetic got wrong.
     */
    it('appends an added reservation at the END, with no id and no position', async () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: buildTenReservations() }) })

      await userEvent.click(reservationsSectionPage.getAddReservationButton())

      const reservations = reservationsSectionPage.getReservations()
      expect(reservations).toHaveLength(11)
      expect(reservations.at(-1)?.kind).toBe('added')
      // Structurally impossible to hold an id, and asserted on the JSON anyway: this is
      // the claim the whole chore is about, and a key that came back as `undefined`
      // would satisfy a value assertion while still being a key on the wire.
      expect(reservations.at(-1) && 'id' in reservations.at(-1)!).toBe(false)
      expect(reservations.at(-1) && 'position' in reservations.at(-1)!).toBe(false)
      // The ten it joined are untouched — same ids, same order.
      expect(reservations.slice(0, 10).map((p) => p.kind)).toEqual(Array(10).fill('kept'))
    })

    /**
     * Remove a reservation from the MIDDLE, then add one. This is where the client's own
     * position arithmetic used to matter (ten reservations minus one is nine, so a
     * count-derived position would have handed the newcomer a `9` that reservation 10 already
     * held) — and where it now matters that there is none: what is sent is nine cited
     * reservations in their director-chosen order, then one id-less entry, and the server reads
     * the positions off that.
     */
    it('keeps the surviving reservations cited, in order, with the newcomer last', async () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: buildTenReservations() }) })

      // The third card is Reservation 3 (position 2).
      await userEvent.click(reservationsSectionPage.getRemoveReservationButtons()[2])
      await userEvent.click(reservationsSectionPage.getAddReservationButton())

      const reservations = reservationsSectionPage.getReservations()
      expect(reservations.map((p) => p.name)).toEqual([
        'Reservation 1',
        'Reservation 2',
        'Reservation 4',
        'Reservation 5',
        'Reservation 6',
        'Reservation 7',
        'Reservation 8',
        'Reservation 9',
        'Reservation 10',
        // Nine reservations were left, so the default name is the tenth letter — the naming and
        // the diff are independent, and only the diff is load-bearing.
        'Reservation J',
      ])
      expect(reservations.map((p) => p.kind)).toEqual([
        ...Array(9).fill('kept'),
        'added',
      ])
      // Reservation 3 is simply gone from the payload — an uncited stored reservation is what a
      // removal IS on the wire (ADR 20260801), never a flag or a tombstone.
      expect(reservations.map((p) => p.name)).not.toContain('Reservation 3')
    })
  })

  /**
   * The two things a reservations save must get right about identity, asserted on the form
   * state the save serializes.
   *
   * They are opposite failures and both are silent: an added reservation that carried an id
   * would be a 422 (`extra_forbidden` on `body.reservations[i].id`) or — before the ids moved
   * server-side — a duplicate, and a stored reservation that lost one would be read as a
   * removal, taking every fixture dealt into it.
   */
  describe('who owns a reservation id', () => {
    it('adds a reservation with NO id — the server mints it', async () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: [buildReservation()] }) })

      await userEvent.click(reservationsSectionPage.getAddReservationButton())

      const [kept, added] = reservationsSectionPage.getReservations()
      expect(kept).toMatchObject({ kind: 'kept', id: 'res-1' })
      expect(added.kind).toBe('added')
      expect('id' in added).toBe(false)
    })

    // …and the other half: editing a stored reservation re-words it, it does not re-create it.
    // Every field the card can touch is exercised, because the card hands its whole draft
    // back through one `onChange` — a mapper that rebuilt the entry from that draft would
    // drop the id on the FIRST keystroke, whichever box it was in.
    it('keeps a stored reservation’s id through a rename, a re-window and a re-table', async () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: [buildReservation()] }) })

      fireEvent.change(reservationsSectionPage.getNameInput(), {
        target: { value: 'Morning Reservation' },
      })
      fireEvent.change(screen.getByLabelText('Start'), {
        target: { value: '10:30' },
      })
      await userEvent.click(reservationsSectionPage.getTableToggle('T9'))

      expect(reservationsSectionPage.getReservations()).toEqual([
        {
          kind: 'kept',
          id: 'res-1',
          name: 'Morning Reservation',
          slot: { date: '2026-06-13', start: '10:30', end: '12:30' },
          tableIds: ['t1', 't2', 't3', 't4', 't9'],
        },
      ])
    })

    /** A card is handed a `ReservationDraft` — three fields — so the arm and the id are not
     * values it can reach, let alone change. Proved by editing an ADDED reservation, the case
     * where a leaked identity would be a client-authored id: it stays id-less. */
    it('cannot promote an added reservation into a kept one by editing it', async () => {
      // An event with no reservations yet, so the one card on screen after the click is the
      // added one and the card-scoped name box addresses it. (`getAddReservationButton` matches
      // both the header's button and the empty state's, so the empty state's is named.)
      reservationsSectionPage.render({ event: buildEvent({ reservations: [] }) })

      await userEvent.click(
        screen.getByRole('button', { name: 'Add first reservation' }),
      )
      fireEvent.change(reservationsSectionPage.getNameInput(), {
        target: { value: 'Reservation Zero' },
      })

      const [added] = reservationsSectionPage.getReservations()
      expect(added).toMatchObject({ kind: 'added', name: 'Reservation Zero' })
      expect('id' in added).toBe(false)
    })
  })

  it('counts distinct double-booked tables, not conflict pairs', () => {
    // One table (t1) shared across three mutually-overlapping reservations yields
    // three conflict pairs but is still a single double-booked table.
    reservationsSectionPage.render({
      event: buildEvent({
        reservations: [
          buildReservation({ id: 'a', name: 'A', slot: { date: '2026-06-13', start: '09:00', end: '12:00' }, tableIds: ['t1'], position: 0 }),
          buildReservation({ id: 'b', name: 'B', slot: { date: '2026-06-13', start: '10:00', end: '13:00' }, tableIds: ['t1'], position: 1 }),
          buildReservation({ id: 'c', name: 'C', slot: { date: '2026-06-13', start: '11:00', end: '14:00' }, tableIds: ['t1'], position: 2 }),
        ],
      }),
    })
    const alert = reservationsSectionPage.queryConflictAlert()
    expect(alert).toHaveTextContent('1 table is double-booked')
    expect(alert).not.toHaveTextContent('3 tables are')
  })

  it('warns when two overlapping reservations share a table', () => {
    reservationsSectionPage.render({
      event: buildEvent({ reservations: conflictingReservations() }),
    })
    expect(reservationsSectionPage.queryConflictAlert()).toHaveTextContent('double-booked')
  })

  it('shows the empty state with no reservations', () => {
    reservationsSectionPage.render({ event: buildEvent({ reservations: [] }) })
    expect(reservationsSectionPage.queryReservationCards()).toHaveLength(0)
    expect(document.body).toHaveTextContent('No reservations yet')
  })

  // ADR-0786's group-set freeze, in the editor. The reservations of an event whose draw is
  // CUT may no longer be added to or removed from — a fixture names its group by id, and a
  // group is minted 1:1 with a reservation (ticket #1369) — but everything else about a
  // reservation stays editable, because venues move under a running tournament. Both halves
  // are asserted, and the second half is the one that matters: a section that greyed itself
  // out wholesale would pass the first three tests here and break the very case the freeze
  // exists to permit.
  describe('once the draw is cut', () => {
    it('disables Add reservation and names the draw as the reason, with the way out', () => {
      reservationsSectionPage.render({ event: buildDrawnEvent() })

      expect(reservationsSectionPage.getAddReservationButton()).toBeDisabled()
      const notice = reservationsSectionPage.queryFrozenNotice()
      expect(notice).toHaveTextContent('This event’s draw is cut')
      // The way out, not merely the refusal: a director who is only told "no" is stuck.
      expect(notice).toHaveTextContent('Delete the draw')
      expect(notice).toHaveTextContent('cut it again')
    })

    it('disables every Remove reservation button, pointing it at that reason', () => {
      reservationsSectionPage.render({ event: buildDrawnEvent() })

      // Both cards — the second is where a "disable the first one" fix would show.
      const removeButtons = reservationsSectionPage.getRemoveReservationButtons()
      expect(removeButtons).toHaveLength(2)
      for (const button of removeButtons) expect(button).toBeDisabled()

      // A disabled button holds no tooltip a screen reader will read, so the reason is
      // in text — and the button says where.
      const notice = reservationsSectionPage.queryFrozenNotice()
      expect(removeButtons[0]).toHaveAttribute('aria-describedby', notice?.id)
    })

    // ⚠️ THE DISCRIMINATING ONE. Only the reservation *identity set* is frozen: a table that
    // breaks mid-event is pulled from its reservation, the reservation slips an hour, a reservation is
    // renamed — all with the draw standing, and none of it costing the director their
    // placements (CONTEXT.md, "Reservation"; `_enforce_group_set_frozen`). Asserted by *doing*
    // each edit and reading the form state back, not by `toBeEnabled()`: a control can
    // be enabled and still wired to nothing.
    //
    // One reservation, so the card-scoped queries address exactly one card (the section-level
    // ones throw on two). It is still a cut draw — one fixture is a draw.
    it('leaves a reservation’s tables, window and name editable', async () => {
      reservationsSectionPage.render({ event: drawnOneReservationEvent() })

      // The table a director pulls when it breaks (the reservation holds t1–t4).
      await userEvent.click(reservationsSectionPage.getSelectedTableToggle('T1'))
      expect(reservationsSectionPage.getReservations()[0].tableIds).not.toContain('t1')

      // …and the one that frees up.
      await userEvent.click(reservationsSectionPage.getTableToggle('T9'))
      expect(reservationsSectionPage.getReservations()[0].tableIds).toContain('t9')

      // The window slips an hour and a half.
      fireEvent.change(screen.getByLabelText('Start'), {
        target: { value: '10:30' },
      })
      expect(reservationsSectionPage.getReservations()[0].slot.start).toBe('10:30')

      // And the display name is only a display name — identity lives in the `id`, which
      // no control here can touch, so every fixture still resolves. (The card is handed
      // three fields and the id is not one of them, which is what makes that structural
      // rather than merely true today.)
      fireEvent.change(reservationsSectionPage.getNameInput(), {
        target: { value: 'Morning Reservation' },
      })
      const [reservation] = reservationsSectionPage.getReservations()
      expect(reservation.name).toBe('Morning Reservation')
      expect(reservation).toMatchObject({ kind: 'kept', id: 'p-1' })

      // None of which added or removed a reservation.
      expect(reservationsSectionPage.getReservations()).toHaveLength(1)
    })

    // The whole freeze turns on the draw existing. With none cut, the section is exactly
    // what it always was — no dead buttons, and nothing to explain.
    it('is not frozen when no draw is cut', () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: twoReservations() }) })

      expect(reservationsSectionPage.getAddReservationButton()).toBeEnabled()
      for (const button of reservationsSectionPage.getRemoveReservationButtons()) {
        expect(button).toBeEnabled()
      }
      expect(reservationsSectionPage.queryFrozenNotice()).toBeNull()
    })

    // A viewer has no add/remove affordance to explain and no draw to delete: the notice
    // would be an instruction they cannot follow, about buttons they cannot see.
    it('shows a non-owner no freeze notice', () => {
      reservationsSectionPage.render({ event: buildDrawnEvent(), canEdit: false })

      expect(reservationsSectionPage.queryFrozenNotice()).toBeNull()
      expect(reservationsSectionPage.getFormElements()).toHaveLength(0)
    })
  })

  /**
   * A reservation is *called* something, and the server now says so (`Reservation.name`,
   * `min_length=1`). The section does not *decide* that — the editor's resolver does,
   * and it is what refuses the save — but the section is where the verdict has to land:
   * under the box that is empty, on the card it is about.
   */
  describe('a reservation with no name', () => {
    it('reds the named reservation’s card and no other', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: twoReservations() }),
        nameIssues: { 'p-2': 'Name is required.' },
      })

      const [reservationA, reservationB] = reservationsSectionPage.getReservationNameInputs()
      expect(reservationsSectionPage.getReservationNameErrors()).toEqual(['Name is required.'])
      expect(reservationB).toHaveAttribute('aria-invalid', 'true')
      expect(reservationA).not.toHaveAttribute('aria-invalid', 'true')
    })

    // Keyed by reservation ID, not by index: a director who removes the first of three reservations
    // renumbers every card, and an index-keyed message would then be red under the
    // wrong box.
    it('follows the reservation it belongs to when a card above it is removed', async () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: twoReservations() }),
        nameIssues: { 'p-2': 'Name is required.' },
      })

      await userEvent.click(reservationsSectionPage.getRemoveReservationButtons()[0])

      // One card left — Reservation B, the blank one — and the red is still under it.
      expect(reservationsSectionPage.queryReservationCards()).toHaveLength(1)
      expect(reservationsSectionPage.getReservationNameErrors()).toEqual(['Name is required.'])
      expect(reservationsSectionPage.getReservationNameInputs()[0]).toHaveAttribute(
        'aria-invalid',
        'true',
      )
    })

    it('says nothing in red when the editor hands it no issues', () => {
      reservationsSectionPage.render({ event: buildEvent({ reservations: twoReservations() }) })
      expect(reservationsSectionPage.getReservationNameErrors()).toEqual([])
    })
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015, rule 6). Rendered *with* reservations on purpose: an
    // event with none has nothing but the Add button, so a sweep over the empty
    // state would never touch a reservation card's date/time inputs or its wall of
    // table toggles — precisely the controls most likely to be left live.
    it('renders no interactive controls', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: twoReservations() }),
        canEdit: false,
      })
      // The DOM sweep first: it is the load-bearing one, so it is the one whose
      // red is worth seeing.
      expect(reservationsSectionPage.getFormElements()).toHaveLength(0)
      expect(reservationsSectionPage.getInteractiveControls()).toHaveLength(0)
    })

    // The per-table toggles are gone, not disabled — a viewer reads the tables
    // a reservation reserves, they do not un-reserve one.
    it('renders no per-table toggles', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: twoReservations() }),
        canEdit: false,
      })
      expect(screen.queryByRole('button', { name: 'T1' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'T12' })).toBeNull()
    })

    it('reads each reservation as its name, its window and its tables', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: twoReservations() }),
        canEdit: false,
      })

      const [first, second] = reservationsSectionPage.queryReservationCards()
      expect(first).toHaveTextContent('Reservation A')
      // In words, not the `YYYY-MM-DD` the editor's date input takes.
      expect(first).toHaveTextContent('Jun 13, 2026')
      expect(first).toHaveTextContent('09:00')
      expect(first).toHaveTextContent('12:30')
      expect(first).toHaveTextContent('T1, T2')
      expect(second).toHaveTextContent('Reservation B')
      expect(second).toHaveTextContent('T3')
    })

    // A double-booking is a flaw in the organizer's configuration and only they
    // can fix it. Shown to a reader it is an unactionable warning about someone
    // else's tournament. The owner's Alert is proved above ("warns when two
    // overlapping reservations share a table") off the same fixture, so this cannot be
    // satisfied by deleting the Alert outright.
    it('hides the double-booking warning', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: conflictingReservations() }),
        canEdit: false,
      })
      expect(reservationsSectionPage.queryConflictAlert()).toBeNull()
      expect(document.body).not.toHaveTextContent('double-booked')
      // The reservations themselves still read back — it is the diagnostic that goes,
      // not the data.
      expect(reservationsSectionPage.queryReservationCards()).toHaveLength(2)
    })

    // Hidden, never disabled: a disabled button is an unexplained dead end.
    it('hides the Add reservation and Remove reservation buttons', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: twoReservations() }),
        canEdit: false,
      })
      expect(reservationsSectionPage.queryAddReservationButton()).toBeNull()
      expect(screen.queryByRole('button', { name: 'Remove reservation' })).toBeNull()
    })

    // "No reservations yet" / "Add a reservation to…" is the organizer's to-do list. A viewer
    // is being told a fact about the event, and is offered nothing to add.
    it('states that no tables are reserved, with no Add button', () => {
      reservationsSectionPage.render({
        event: buildEvent({ reservations: [] }),
        canEdit: false,
      })
      expect(screen.getByText('No reservations')).toBeInTheDocument()
      expect(
        screen.getByText('No tables are reserved for this event.'),
      ).toBeInTheDocument()
      expect(document.body).not.toHaveTextContent('No reservations yet')
      expect(reservationsSectionPage.queryAddReservationButton()).toBeNull()
      expect(reservationsSectionPage.getFormElements()).toHaveLength(0)
    })
  })
})
