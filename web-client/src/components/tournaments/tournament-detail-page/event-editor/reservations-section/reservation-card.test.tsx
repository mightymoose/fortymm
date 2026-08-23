import userEvent from '@testing-library/user-event'

import { fireEvent, screen } from '@/test/utilities'

import { buildReservation } from '../../../data/seed.factory'
import { reservationCardPage } from './reservation-card.page'

describe('ReservationCard', () => {
  it('marks the selected tables as pressed', () => {
    reservationCardPage.render({ reservation: buildReservation({ tableIds: ['t1', 't2'] }) })
    expect(reservationCardPage.getSelectedTableToggle('T1')).toBeInTheDocument()
    expect(reservationCardPage.getTableToggle('T5')).toBeInTheDocument()
  })

  it('adds an unselected table on click', async () => {
    const onChange = vi.fn()
    reservationCardPage.render({ reservation: buildReservation({ tableIds: ['t1'] }), onChange })
    await userEvent.click(reservationCardPage.getTableToggle('T5'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: ['t1', 't5'] }),
    )
  })

  it('removes the reservation', async () => {
    const onRemove = vi.fn()
    reservationCardPage.render({ onRemove })
    await userEvent.click(reservationCardPage.getRemoveButton())
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  // The reservation window carries the event's timezone as a caption (ADR 20260719) — the
  // frame its wall-clock times are in. A reservation holds no zone of its own; the event's
  // is handed down.
  it('labels the window with the event timezone', () => {
    reservationCardPage.render({ timezone: 'America/Denver' })
    expect(reservationCardPage.getTimezoneLabel()).toHaveTextContent('America/Denver')
  })

  /**
   * The name box is the one control on this card that can author a reservation the server
   * refuses (`Reservation.name`, `min_length=1`) — the id and the default name are minted. The
   * card does not *judge* the name (the editor's resolver does, and refuses the save);
   * what it owes is the verdict, under the box, in red, wired so a screen reader hears
   * it too.
   */
  describe('a name the server would refuse', () => {
    it('renders the message under the box, and marks the box invalid', () => {
      reservationCardPage.render({
        reservation: buildReservation({ name: '' }),
        nameError: 'Name is required.',
      })

      expect(reservationCardPage.queryNameError()).toHaveTextContent('Name is required.')
      expect(reservationCardPage.getNameInput()).toHaveAttribute('aria-invalid', 'true')
    })

    // A `<p>` that merely sits below an input is *beside* it on screen and nowhere at
    // all to a screen reader.
    it('points the box at the message', () => {
      reservationCardPage.render({
        reservation: buildReservation({ name: '' }),
        nameError: 'Name is required.',
      })

      const describedBy = reservationCardPage.getNameInput().getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(reservationCardPage.queryNameError()).toHaveAttribute('id', describedBy)
    })

    it('says nothing, and claims nothing, when the name is fine', () => {
      reservationCardPage.render({ reservation: buildReservation({ name: 'Reservation A' }) })

      expect(reservationCardPage.queryNameError()).toBeNull()
      expect(reservationCardPage.getNameInput()).not.toHaveAttribute('aria-invalid', 'true')
      // No dangling description either — an `aria-describedby` pointing at an element
      // that is not there is an axe violation of its own.
      expect(reservationCardPage.getNameInput()).not.toHaveAttribute('aria-describedby')
    })

    // A viewer has no box to clear, so there is nothing to tell them to fix. (The
    // editor never hands one down for a read-only card; this is the card refusing to
    // render one even if it did.)
    it('tells a viewer nothing about a name they cannot edit', () => {
      reservationCardPage.render({
        reservation: buildReservation({ name: '' }),
        nameError: 'Name is required.',
        canEdit: false,
      })

      expect(reservationCardPage.queryNameError()).toBeNull()
      expect(reservationCardPage.queryNameInput()).toBeNull()
    })
  })

  /**
   * #1501: a window the server would refuse — end not after start, or outside the
   * event's own window. `ReservationCard` does not judge it (the editor's resolver
   * does, via `reservationWindowIssues`); what it owes is the verdict, under the
   * window it is about, in red, wired so a screen reader hears it too — the same
   * treatment `nameError` already gets.
   */
  describe('a window the server would refuse', () => {
    it('renders the message under the window, and marks all three boxes invalid', () => {
      reservationCardPage.render({
        windowError: 'This window must end after it starts.',
      })

      expect(reservationCardPage.queryWindowError()).toHaveTextContent(
        'This window must end after it starts.',
      )
      expect(reservationCardPage.getDateInput()).toHaveAttribute('aria-invalid', 'true')
      expect(reservationCardPage.getStartInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(reservationCardPage.getEndInput()).toHaveAttribute('aria-invalid', 'true')
    })

    // A `<p>` that merely sits below the grid is *beside* it on screen and nowhere at
    // all to a screen reader.
    it('points the boxes at the message', () => {
      reservationCardPage.render({
        windowError: 'This window must end after it starts.',
      })

      const describedBy = reservationCardPage
        .getStartInput()
        .getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(reservationCardPage.queryWindowError()).toHaveAttribute('id', describedBy)
    })

    it('says nothing, and claims nothing, when the window is fine', () => {
      reservationCardPage.render({})

      expect(reservationCardPage.queryWindowError()).toBeNull()
      expect(reservationCardPage.getStartInput()).not.toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(reservationCardPage.getStartInput()).not.toHaveAttribute(
        'aria-describedby',
      )
    })

    // A viewer has no window to fix, so there is nothing to tell them.
    it('tells a viewer nothing about a window they cannot edit', () => {
      reservationCardPage.render({
        windowError: 'This window must end after it starts.',
        canEdit: false,
      })

      expect(reservationCardPage.queryWindowError()).toBeNull()
    })

    // The window box stays live under a #1501 refusal — editing it is exactly how the
    // director fixes it, so `onChange` must still fire.
    it('leaves the window editable while it is red', () => {
      const onChange = vi.fn()
      reservationCardPage.render({
        windowError: 'This window must end after it starts.',
        onChange,
      })

      fireEvent.change(reservationCardPage.getEndInput(), {
        target: { value: '13:15' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ slot: expect.objectContaining({ end: '13:15' }) }),
      )
    })
  })

  // The reservation-set freeze, at the level of one card (ADR-0786). The *reason* is not the
  // card's to say — the section says it once, above the cards — so what the card owes is
  // a dead button that points at it.
  describe('when the event’s draw is cut', () => {
    it('disables the remove button and points it at the reason', async () => {
      const onRemove = vi.fn()
      reservationCardPage.render({
        removal: { kind: 'frozen', reasonId: 'freeze-notice' },
        onRemove,
      })

      const button = reservationCardPage.getRemoveButton()
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-describedby', 'freeze-notice')
      // Disabled means disabled: the click is refused by the DOM, not merely styled away.
      await userEvent.click(button)
      expect(onRemove).not.toHaveBeenCalled()
    })

    // Disabled, not hidden — this is the case a director can get *out* of (delete the
    // draw), unlike the viewer's, whose buttons never come back. Hiding it would take
    // the way out with it.
    it('still renders the remove button', () => {
      reservationCardPage.render({
        removal: { kind: 'frozen', reasonId: 'freeze-notice' },
      })
      expect(reservationCardPage.queryRemoveButton()).toBeInTheDocument()
    })

    // The whole reason the freeze is scoped to identity: a table breaks and is pulled, a
    // reservation slips an hour, a reservation is renamed — all of it mid-event, none of it costing
    // the draw. A card that greyed itself out wholesale would break exactly this.
    it('leaves the name, the window and the table toggles live', async () => {
      const onChange = vi.fn()
      reservationCardPage.render({
        reservation: buildReservation({ tableIds: ['t1'] }),
        removal: { kind: 'frozen', reasonId: 'freeze-notice' },
        onChange,
      })

      await userEvent.click(reservationCardPage.getTableToggle('T5'))
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ tableIds: ['t1', 't5'] }),
      )

      fireEvent.change(reservationCardPage.getNameInput(), {
        target: { value: 'Morning Reservation' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'Morning Reservation' }),
      )

      fireEvent.change(screen.getByLabelText('End'), {
        target: { value: '13:15' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          slot: expect.objectContaining({ end: '13:15' }),
        }),
      )
    })
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015, rule 6): a viewer gets a rendering of the data,
    // never a disabled editor. The DOM sweep, not a role sweep — this card's
    // window is three `type="date"` / `type="time"` inputs, and those carry no
    // ARIA role at all, so the four canonical roles would miss a live date row
    // entirely and go green with the whole window still editable.
    it('renders no interactive controls', () => {
      reservationCardPage.render({ canEdit: false })
      // The DOM sweep first: it is the load-bearing one, so it is the one whose
      // red is worth seeing.
      expect(reservationCardPage.getFormElements()).toHaveLength(0)
      expect(reservationCardPage.getInteractiveControls()).toHaveLength(0)
    })

    it('reads the reservation name as text, not a name box', () => {
      reservationCardPage.render({
        reservation: buildReservation({ name: 'Reservation A' }),
        canEdit: false,
      })
      expect(reservationCardPage.getName()).toHaveTextContent('Reservation A')
      expect(reservationCardPage.queryNameInput()).toBeNull()
    })

    // The date reads in words, never as the `YYYY-MM-DD` the editor's
    // `<input type="date">` takes. The times have no such helper and stay raw
    // here, on the event card, and everywhere else.
    it('reads the window back under the same Date / Start / End labels', () => {
      reservationCardPage.render({
        reservation: buildReservation({
          slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
        }),
        canEdit: false,
      })
      expect(reservationCardPage.getFieldValue('Date')).toHaveTextContent(
        'Jun 13, 2026',
      )
      expect(reservationCardPage.getFieldValue('Start')).toHaveTextContent('09:00')
      expect(reservationCardPage.getFieldValue('End')).toHaveTextContent('12:30')
      expect(screen.queryByText('2026-06-13')).toBeNull()
    })

    // The reserved tables are the point of a reservation. Read-only they are a list of
    // the very labels the toggles showed — no second vocabulary.
    it('lists the tables the reservation reserves', () => {
      reservationCardPage.render({
        reservation: buildReservation({ tableIds: ['t1', 't2', 't5'] }),
        canEdit: false,
      })
      expect(reservationCardPage.getReservedTables()).toHaveTextContent('T1, T2, T5')
    })

    // Catalogue order, not the order the organizer happened to click them in.
    it('lists the tables in catalogue order', () => {
      reservationCardPage.render({
        reservation: buildReservation({ tableIds: ['t5', 't1'] }),
        canEdit: false,
      })
      expect(reservationCardPage.getReservedTables()).toHaveTextContent('T1, T5')
    })

    // A reservation that reserves nothing is unset, not blank: an em-dash, so absent
    // stays distinguishable from not-applicable (ADR 0015, rule 3).
    it('reads a reservation with no tables as an em-dash', () => {
      reservationCardPage.render({ reservation: buildReservation({ tableIds: [] }), canEdit: false })
      expect(reservationCardPage.getReservedTables()).toHaveTextContent('—')
    })

    // Hidden, never disabled: a disabled button is an unexplained dead end.
    it('hides the remove button', () => {
      reservationCardPage.render({ canEdit: false })
      expect(reservationCardPage.queryRemoveButton()).toBeNull()
    })

    // The timezone caption is a fact about the window a reader is owed too — and it
    // is a plain caption, not a control, so it survives the read-only guard.
    it('still labels the window with the timezone', () => {
      reservationCardPage.render({ timezone: 'America/New_York', canEdit: false })
      expect(reservationCardPage.getTimezoneLabel()).toHaveTextContent('America/New_York')
    })
  })
})
