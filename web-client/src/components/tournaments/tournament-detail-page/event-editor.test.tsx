import { fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach } from 'vitest'

import { ApiError } from '@/api/client'
import { screen, waitFor } from '@/test/utilities'

import { emptyEvent } from '../data/helpers'
import { eventToCreateBody, eventToUpdateBody } from '../data/api'
import {
  buildDrawnEvent,
  buildEvent,
  buildFixture,
  buildReservation,
  buildPredicate,
  buildRrThenKoEvent,
  buildSwissEvent,
  buildTournament,
  groupIdFor,
} from '../data/seed.factory'
import { eventEditorPage } from './event-editor.page'
import { reservationCardPage } from './event-editor/reservations-section/reservation-card.page'

// A name genuinely past the server's VARCHAR(255) limit — the #933 case. A short
// name would sail through the client schema and prove nothing.
const OVER_LONG_NAME = 'A'.repeat(300)

describe('EventEditor', () => {
  it('saves the working draft and closes on success', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    eventEditorPage.render({
      event: buildEvent({ name: 'Open Singles' }),
      onSave,
      onClose,
    })

    await userEvent.click(eventEditorPage.getSaveButton())
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Open Singles' }),
      ),
    )
    // The panel closes only after the save resolves.
    // `force`, so the guard is skipped: the work has just been persisted.
    expect(onClose).toHaveBeenCalledWith({ force: true })
  })

  /**
   * **K**, through the whole editor (ADR 20260727) — the picker, the resolver, and the
   * body that leaves the client.
   *
   * The section's own tests prove the row is conditional; these prove the three things
   * only the *editor* can: that switching the served picker reveals and hides it, that a
   * bad count is refused BEFORE anything is sent, and — the one that matters most — that
   * the value a director types is on the object handed to `onSave`, which is what
   * `eventToUpdateBody` turns into the request. A test that stopped at form state would
   * pass just as happily against a mapper that dropped the field on the floor.
   */
  describe('the qualifier count, end to end', () => {
    it('reveals the control when the director picks the two-stage format, and hides it again', async () => {
      eventEditorPage.render({ event: buildEvent({ drawType: 'round-robin' }) })
      expect(eventEditorPage.queryQualifiersInput()).toBeNull()

      // The label is the SERVER's (`draw_type_catalogue`), not a string this client keeps.
      await eventEditorPage.chooseDrawType('Round-robin then knockout')
      expect(await screen.findByLabelText(/Qualifiers per group/)).toBeInTheDocument()

      await eventEditorPage.chooseDrawType('Round robin')
      await waitFor(() =>
        expect(eventEditorPage.queryQualifiersInput()).toBeNull(),
      )
    })

    // ⚠️ THE CLAIM IS ABOUT THE REQUEST, not the box. `onSave` receives the event the
    // page maps with `eventToUpdateBody`, so mapping it here is what the client would
    // really put on the wire — and 2 is neither the planner's fallback (1) nor absent.
    it('SENDS the configured count — the value reaches the request body', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildRrThenKoEvent({ qualifiersPerGroup: 1 }),
        onSave,
      })

      fireEvent.change(eventEditorPage.getQualifiersInput(), {
        target: { value: '2' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(eventToUpdateBody(onSave.mock.calls[0][0]).qualifiers_per_group).toBe(2)
    })

    // The stale-value case, and the reason the mapper keys off the draw type rather than
    // off "is there a number in the box": switching away leaves K in form state (RHF does
    // not clear a field because its control unmounted), and the two count-less arms of the
    // server's draw-settings union are `extra="forbid"` — so a body that still carried it
    // would be a **422**, produced by a control the director can no longer even see.
    it('drops the count from the body when the director switches away from rr-then-ko', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        // ONE reservation: #1482 caps a round-robin event at one, and this test's own
        // claim is about `qualifiers_per_group`, not about how many reservations survive
        // the flip.
        event: buildRrThenKoEvent({
          qualifiersPerGroup: 2,
          reservations: [buildReservation({ id: 'res-a', name: 'Reservation A' })],
        }),
        onSave,
      })

      await eventEditorPage.chooseDrawType('Round robin')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      const body = eventToUpdateBody(onSave.mock.calls[0][0])
      expect(body.draw_type).toBe('round-robin')
      expect('qualifiers_per_group' in body).toBe(false)
    })

    // Refused HERE, so nothing was sent — `onSave` not called at all is the assertion
    // that separates "told the director" from "asked the server and read the answer out".
    it.each([
      ['0', 'At least 1 player must advance from each group.'],
      ['-1', 'At least 1 player must advance from each group.'],
      ['', 'Say how many players advance from each group.'],
    ])(
      'refuses %s inline and sends NOTHING',
      async (typed, message) => {
        const onSave = vi.fn()
        eventEditorPage.render({
          event: buildRrThenKoEvent({ qualifiersPerGroup: 2 }),
          onSave,
        })

        fireEvent.change(eventEditorPage.getQualifiersInput(), {
          target: { value: typed },
        })
        await userEvent.click(eventEditorPage.getSaveButton())

        await waitFor(() =>
          expect(eventEditorPage.queryFieldError(message)).toBeInTheDocument(),
        )
        expect(onSave).not.toHaveBeenCalled()
      },
    )

    // The far half of the round trip (chores 3c/3d): what the SERVER stored is what the
    // control opens on. Without this the editor could show a default while the event ran
    // at a different K — the quiet failure the whole server-side detour was to prevent.
    it('opens on the count the server sent back', () => {
      eventEditorPage.render({ event: buildRrThenKoEvent({ qualifiersPerGroup: 3 }) })

      expect(eventEditorPage.getQualifiersInput()).toHaveValue(3)
    })
  })

  /**
   * **The Draw structure tab is conditional** (ADR 20260808, #1320). Only `rr-then-ko`
   * has a group stage feeding a knockout, so only `rr-then-ko` has a structure to set:
   * for the other three formats the tab is *absent*, not empty and not disabled.
   *
   * The section's own tests pin what the tab says. These pin the three things only the
   * editor can: that the tab is on the list, that it is off the list for every other
   * draw type, and that switching format out from under a director standing on it does
   * not leave them looking at a blank sheet.
   */
  describe('the Draw structure tab', () => {
    it('is the fifth tab for a two-stage event', () => {
      eventEditorPage.render({ event: buildRrThenKoEvent() })

      expect(eventEditorPage.getSectionTabLabels()).toEqual([
        'Basics',
        'Eligibility',
        'Match settings',
        'Reservations',
        'Draw structure',
      ])
    })

    it.each([
      ['round-robin', () => buildEvent({ drawType: 'round-robin' })],
      ['single-elim', () => buildEvent({ drawType: 'single-elim', reservations: [] })],
      ['swiss', () => buildSwissEvent()],
    ] as const)('is absent for %s', (_drawType, build) => {
      eventEditorPage.render({ event: build() })

      expect(eventEditorPage.querySectionTab('Draw structure')).toBeNull()
      expect(eventEditorPage.getSectionTabLabels()).toHaveLength(4)
    })

    it('opens onto the four settings, derived from the draft', async () => {
      eventEditorPage.render({
        event: buildRrThenKoEvent({
          maxPlayers: 32,
          reservations: [
            buildReservation({ id: 'res-a', name: 'Reservation A', position: 0 }),
            buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          ],
        }),
      })

      await userEvent.click(eventEditorPage.getSectionTab('Draw structure'))

      // Wiring only: every value and sentence is pinned by the section's own tests.
      expect(eventEditorPage.drawStructure.getSettingNames()).toEqual([
        'Group count',
        'Group size',
        'Membership',
        'Qualifiers per group',
      ])
      expect(
        eventEditorPage.drawStructure.setting('Group size').getSource(),
      ).toHaveTextContent('32 players ÷ 7 groups')
    })

    // The draft is what the tab is keyed on, so the picker reveals and hides it live —
    // the same claim the qualifier-count row makes one tab over.
    it('appears when the director picks the two-stage format', async () => {
      eventEditorPage.render({ event: buildEvent({ drawType: 'round-robin' }) })
      expect(eventEditorPage.querySectionTab('Draw structure')).toBeNull()

      await eventEditorPage.chooseDrawType('Round-robin then knockout')

      expect(
        await screen.findByRole('tab', { name: 'Draw structure' }),
      ).toBeInTheDocument()
    })

    /**
     * …and goes again when they change their mind — the round trip, and the case that
     * leaves a director looking at a blank sheet if the tab list and the panel ever
     * disagree (Radix renders no panel for a `value` that matches no trigger).
     *
     * The picker lives on Basics, so a director necessarily walks back there to switch
     * format: the assertion is that they are still standing on a real tab afterwards.
     */
    it('goes again when the director switches away, leaving them on a live tab', async () => {
      eventEditorPage.render({ event: buildRrThenKoEvent() })

      await userEvent.click(eventEditorPage.getSectionTab('Draw structure'))
      await userEvent.click(eventEditorPage.getSectionTab('Basics'))
      await eventEditorPage.chooseDrawType('Round robin')

      await waitFor(() =>
        expect(eventEditorPage.querySectionTab('Draw structure')).toBeNull(),
      )
      expect(eventEditorPage.getSectionTab('Basics')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(eventEditorPage.getNameInput()).toBeInTheDocument()
    })

    // The tab reaches back to the tab that owns the number it derives against.
    it('takes the director to Basics from the preview-field block', async () => {
      eventEditorPage.render({ event: buildRrThenKoEvent() })

      await userEvent.click(eventEditorPage.getSectionTab('Draw structure'))
      await userEvent.click(
        eventEditorPage.drawStructure.getChangeInBasicsButton(),
      )

      expect(eventEditorPage.getSectionTab('Basics')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(eventEditorPage.getPlayerLimitInput()).toBeInTheDocument()
    })
  })

  /**
   * A rule with no value is not a rule. It used to go to the server anyway — where
   * a scalar one was ACCEPTED (201) and came back onto the event card as the chip
   * `Rating < ?`, a restriction on nobody wearing the clothes of a real one, while a
   * `between` with no bounds earned a 422 the editor threw away along with the
   * organizer's work.
   *
   * So: refused in the form. Nothing is sent — `onSave` is not called at all, which
   * is the assertion that separates "told the user" from "asked the server and
   * ignored the answer".
   */
  describe('a rule the server could not evaluate', () => {
    it('refuses a scalar rule with no value, and sends NOTHING', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: null })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual(['Enter a rating.'])
      // …and it took the organizer to the rule that is wrong. A message on a tab
      // you cannot see is indistinguishable from a button that does nothing.
      expect(eventEditorPage.getSectionTab('Eligibility')).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })

    // QA's data-loss repro, exactly: add a rule, set "is between", leave both
    // bounds empty, press Create event.
    it('refuses a between with both bounds empty', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          id: 'new-1',
          predicates: [buildPredicate({ op: 'between', value: [null, null] })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual(['Enter a rating.'])
    })

    it('refuses INVERTED bounds — a rule no player can satisfy', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: 'between', value: [1600, 1200] })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual([
        'The upper bound must be at least the lower bound.',
      ])
    })

    it('refuses a rating that is not a rating', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: 999_999_999 })],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getRuleErrorMessages()).toEqual([
        'Rating must be 0–3000.',
      ])
    })

    it('says nothing in red until the organizer actually tries to save', () => {
      // A value box they have not filled in yet is not yet wrong.
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: null })],
        }),
      })
      expect(eventEditorPage.getRuleErrors()).toHaveLength(0)
    })

    it('clears the message the moment the rule is fixed, and then saves', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ op: '<', value: null })],
        }),
        onSave,
      })
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(eventEditorPage.getRuleErrors()).toHaveLength(1)

      await userEvent.type(eventEditorPage.getValueInput(), '1500')

      expect(eventEditorPage.getRuleErrors()).toHaveLength(0)
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          predicates: [expect.objectContaining({ value: 1500 })],
        }),
      )
    })
  })

  /**
   * The fields the *server* can refuse — and which the form now refuses first (#783
   * QA, round two). The rules got a guard and the name did not, so an empty name and
   * a 256-character one both round-tripped to a 422 while an empty rule was caught in
   * the form. Same click, two different stories.
   *
   * As with the rules: nothing is sent (`onSave` is never called), the message is
   * under the field, and the organizer lands on the tab that holds it.
   */
  describe('a field the server would refuse', () => {
    it('refuses a BLANK name in the form, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'new-1', name: '' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getNameInput()).toHaveAttribute('aria-invalid', 'true')
      expect(eventEditorPage.queryFieldError('Name is required.')).toBeInTheDocument()
      // No banner: a banner is for a refusal that came back from somewhere. This one
      // never left the room.
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    it('refuses a name past 255 characters in the form, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', name: 'A'.repeat(256) }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(
        eventEditorPage.queryFieldError('Name must be 255 characters or fewer.'),
      ).toBeInTheDocument()
    })

    // ⚠️ The one field where a blank box is **not** an error. `Number('')` is `0`, and
    // the old control's coercion turned an emptied player limit into an event of zero
    // players — a 422 the form never caught. The fix is NOT to make the field required
    // (that would un-ship the uncapped event): a blank cap is `null`, which means *no
    // cap*, and it is a perfectly good thing to save (ADR-0935). What is refused is the
    // typed `0` — see 'rejects a zero player limit inline' below, and the two are
    // asserted separately precisely because one coercion used to collapse them.
    it('SAVES a cleared player limit as null — a blank cap is no cap, not an error', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', maxPlayers: 64 }),
        onSave,
      })

      await userEvent.clear(eventEditorPage.getPlayerLimitInput())
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      // `null`, never `0` and never `NaN` — the three are one keystroke apart and only
      // one of them means "no cap".
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ maxPlayers: null }),
      )
      // …and nothing was reported as wrong, because nothing is.
      expect(eventEditorPage.getPlayerLimitInput()).not.toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    it('refuses a player limit the server cannot STORE (the 500), and sends nothing', async () => {
      // `9999999999` satisfies every rule Pydantic states (`int`, `gt=0`) and then
      // detonates on the `Integer` column. The `<input max>` attribute steers a spinner
      // and stops nothing that is typed or pasted, so the bound has to be in the schema.
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      fireEvent.change(eventEditorPage.getPlayerLimitInput(), {
        target: { value: '9999999999' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(
          eventEditorPage.queryFieldError('The player limit must be 512 or fewer.'),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    it('takes the organizer to BASICS, where the broken field is', async () => {
      // The rule builder's lesson, applied to the other tab: a message on a tab you
      // cannot see is indistinguishable from a button that does nothing. Start them
      // on Eligibility to prove the editor really moves them.
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1', name: '' }), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Eligibility'))
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(eventEditorPage.getSectionTab('Basics')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    it('says nothing in red until the organizer actually tries to save', () => {
      eventEditorPage.render({ event: buildEvent({ id: 'new-1', name: '' }) })
      expect(eventEditorPage.queryFieldError('Name is required.')).toBeNull()
    })

    it('clears the message the moment the name is typed, and then saves', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'new-1', name: '' }), onSave })
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(eventEditorPage.queryFieldError('Name is required.')).toBeInTheDocument()

      await userEvent.type(eventEditorPage.getNameInput(), 'Open Singles')

      expect(eventEditorPage.queryFieldError('Name is required.')).toBeNull()
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Open Singles' }),
      )
    })
  })

  /**
   * The same lesson, one tab over — and the last field in this editor that could still
   * author a 422 (#786).
   *
   * The reservations editor **mints** a reservation's id and its default name
   * ("Reservation A"), so the happy path could never make a blank one. But the name
   * **box is live**, and an emptied box was a save the form allowed and the server
   * refused — with Pydantic's own prose ("String should have at least 1 character")
   * arriving in the editor's banner, naming no field, in the wire's vocabulary. The API
   * now states the floor (`Reservation.name`, `min_length=1`), and this is what means
   * the organizer never meets it.
   *
   * ⚠️ The assertion that discriminates is **`onSave`**, not the red. A form that
   * rendered the message and fired the request anyway would sail through a test that
   * only looked for the message — and the 422 would come back and land in the banner
   * exactly as before. Nothing may be *sent*.
   */
  describe('a reservation the server would refuse', () => {
    it('refuses a BLANK reservation name in the form, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ reservations: [buildReservation({ name: 'Reservation A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.clear(eventEditorPage.getReservationNameInput())
      await userEvent.click(eventEditorPage.getSaveButton())

      // Nothing left the room — so the 422 that would have come back never existed.
      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getReservationNameInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(eventEditorPage.getReservationNameErrors()).toEqual(['Name is required.'])
      // And no banner: a banner reports a refusal that came back from somewhere.
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    // A space is not a name, and the server agrees — Pydantic's `min_length` counts the
    // characters it was *sent*, so a client that trimmed only on display would post
    // `" "` and be refused. The schema trims first, exactly as the event's name does.
    it('refuses a WHITESPACE-ONLY reservation name, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ reservations: [buildReservation({ name: 'Reservation A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.clear(eventEditorPage.getReservationNameInput())
      await userEvent.type(eventEditorPage.getReservationNameInput(), '   ')
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getReservationNameErrors()).toEqual(['Name is required.'])
    })

    it('takes the organizer to RESERVATIONS, where the broken reservation is', async () => {
      // A message on a tab you cannot see is indistinguishable from a button that does
      // nothing — the rule builder's lesson, and the name box's, applied to the fourth
      // tab. The editor opens on Basics, so this proves it really moves them.
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ reservations: [buildReservation({ name: '' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(eventEditorPage.getSectionTab('Reservations')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    // Per ROW, not per section: the red belongs under the box that is empty. A section
    // that raised one error for the whole list would point a director with six
    // reservations at all six.
    it('reds the reservation that is blank, and leaves the one that is not alone', async () => {
      eventEditorPage.render({
        event: buildEvent({
          reservations: [
            buildReservation({ id: 'res-a', name: '' }),
            buildReservation({ id: 'res-b', name: 'Reservation B' }),
          ],
        }),
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      expect(eventEditorPage.getReservationNameErrors()).toEqual(['Name is required.'])
      const [blank, named] = eventEditorPage.getReservationNameInputs()
      expect(blank).toHaveAttribute('aria-invalid', 'true')
      expect(named).not.toHaveAttribute('aria-invalid', 'true')
    })

    it('says nothing in red until the organizer actually tries to save', async () => {
      eventEditorPage.render({
        event: buildEvent({ reservations: [buildReservation({ name: 'Reservation A' })] }),
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.clear(eventEditorPage.getReservationNameInput())

      // A box they are halfway through re-typing is not yet wrong.
      expect(eventEditorPage.getReservationNameErrors()).toEqual([])
    })

    it('clears the message the moment the name is typed, and then saves', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ reservations: [buildReservation({ name: '' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())
      expect(eventEditorPage.getReservationNameErrors()).toEqual(['Name is required.'])

      await userEvent.type(eventEditorPage.getReservationNameInput(), 'Championship')

      await waitFor(() => expect(eventEditorPage.getReservationNameErrors()).toEqual([]))
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave.mock.calls.at(-1)?.[0].reservations[0].name).toBe('Championship')
    })

    // The name is trimmed on the way out, so what is saved is the name that will be
    // read off a wall — and what is *counted* by the server's `min_length` is the same
    // string the client judged.
    it('saves the reservation name trimmed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ reservations: [buildReservation({ name: 'Reservation A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.clear(eventEditorPage.getReservationNameInput())
      await userEvent.type(eventEditorPage.getReservationNameInput(), '  Championship  ')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave.mock.calls.at(-1)?.[0].reservations[0].name).toBe('Championship')
    })
  })

  /**
   * #1501: a reservation's window must end after it starts and must fall inside its
   * event's own window (bounds inclusive, and the reservation's date must equal the
   * event's). The seeded event's slot is `09:00`–`18:00` on `2026-06-13`, and its one
   * seeded reservation (`09:00`–`12:30`, same date) is contained by construction — every
   * case below edits exactly one of the three window fields to break exactly one rule.
   */
  describe('a reservation window the server would refuse (#1501)', () => {
    it('refuses an end-before-start reservation, reds that row, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '13:00' } })
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } })
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(
        screen.getByTestId('reservation-window-error'),
      ).toHaveTextContent('This window must end after it starts.')
      // No banner: a banner reports a refusal that came back from somewhere.
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    it('refuses a zero-length reservation — end equal to start', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } })
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByTestId('reservation-window-error')).toHaveTextContent(
        'This window must end after it starts.',
      )
    })

    it('refuses a reservation dated off the event', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('Date'), {
        target: { value: '2026-06-14' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      // States the event's own window, so the director can read the target without
      // leaving this tab for Basics.
      expect(screen.getByTestId('reservation-window-error')).toHaveTextContent(
        "the event's own window",
      )
    })

    it('refuses a reservation whose window falls outside the event’s', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '19:00' } })
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByTestId('reservation-window-error')).toBeInTheDocument()
    })

    // Bounds are INCLUSIVE — a reservation widened to exactly match the event's window
    // still saves.
    it('accepts a reservation whose window exactly equals the event’s', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '09:00' } })
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '18:00' } })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
    })

    // Per ROW, not per section — several bad reservations, several messages.
    it('names every bad row with its own message', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildEvent({
          reservations: [
            buildReservation({
              id: 'res-a',
              name: 'Reservation A',
              slot: { date: '2026-06-13', start: '13:00', end: '09:00' },
              position: 0,
            }),
            buildReservation({
              id: 'res-b',
              name: 'Reservation B',
              slot: { date: '2026-06-20', start: '09:00', end: '10:00' },
              position: 1,
            }),
          ],
        }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      const errors = screen.queryAllByTestId('reservation-window-error')
      expect(errors).toHaveLength(2)
      expect(errors[0]).toHaveTextContent('This window must end after it starts.')
      expect(errors[1]).toHaveTextContent("the event's own window")
      expect(onSave).not.toHaveBeenCalled()
    })

    it('says nothing in red until the organizer actually tries to save', async () => {
      eventEditorPage.render({ event: buildEvent() })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } })

      expect(screen.queryByTestId('reservation-window-error')).toBeNull()
    })

    it('clears the message the moment the window is fixed, and then saves', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } })
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(screen.getByTestId('reservation-window-error')).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('End'), { target: { value: '12:30' } })
      await waitFor(() =>
        expect(screen.queryByTestId('reservation-window-error')).toBeNull(),
      )

      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalled())
    })

    // A new reservation defaults to the event's own window (`reservations-section.tsx`,
    // `slot: { ...eventSlot }`) and so is contained BY CONSTRUCTION — adding one must
    // never start in a refused state, even once `isSubmitted` is armed and every other
    // row's red is live. `isSubmitted` is armed with a first, otherwise-clean Save (an
    // empty reservation list saves fine — containment has nothing to judge), which is
    // what makes this test discriminating: added BEFORE any Save, `windowIssues` is
    // `undefined` and this would pass against anything.
    it('adding a reservation never starts refused, once `isSubmitted` is armed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ reservations: [] }), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

      // The empty state's OWN "Add first reservation" button, not the header's — an
      // empty list renders both, and `getAddReservationButton`'s regex matches either.
      await userEvent.click(
        screen.getByRole('button', { name: 'Add first reservation' }),
      )
      expect(screen.queryByTestId('reservation-window-error')).toBeNull()

      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
      expect(onSave.mock.calls.at(-1)?.[0].reservations).toHaveLength(1)
    })
  })

  /**
   * #1501, rule 3: the event's own slot must end after it starts — an inverted event
   * slot makes every reservation uncontainable, so this has to refuse before the
   * Reservations tab is even worth judging.
   */
  describe('the event’s own slot the server would refuse (#1501)', () => {
    it('refuses an end-before-start event slot, reports it on Basics under the grid, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent(), onSave })

      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '18:00' } })
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } })
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByTestId('event-slot-error')).toHaveTextContent(
        'This window must end after it starts.',
      )
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    /**
     * ⚠️ **A cleared box, not merely an inverted pair.** `<input type="date">` and
     * `<input type="time">` cannot emit anything malformed, but they CAN be cleared —
     * and a blank Start next to an untouched real End would, without the parse check,
     * read as "ordered" (`isSlotOrdered`'s string comparison sorts `''` before every real
     * `HH:MM`) and build a request the server 500s trying to parse.
     */
    it('refuses a CLEARED Start box, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent(), onSave })

      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '' } })
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByTestId('event-slot-error')).toHaveTextContent(
        'The date and both times are required.',
      )
    })

    it('refuses a CLEARED Date box, even with an otherwise-ordered window', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ reservations: [] }), onSave })

      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '' } })
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByTestId('event-slot-error')).toHaveTextContent(
        'The date and both times are required.',
      )
    })

    // `firstErrorTab` (named `firstInvalidSection` in the code, `event-form.ts`) routes
    // the director to the tab holding the first error — a save refused on a tab you
    // cannot see is indistinguishable from a button that does nothing.
    it('routes the director to Basics even when they are looking at Reservations', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent(), onSave })

      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '18:00' } })
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } })
      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(eventEditorPage.getSectionTab('Basics')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    it('says nothing in red until the organizer actually tries to save', () => {
      eventEditorPage.render({
        event: buildEvent({
          slot: { date: '2026-06-13', start: '18:00', end: '09:00' },
        }),
      })
      expect(screen.queryByTestId('event-slot-error')).toBeNull()
    })

    it('clears the message the moment the slot is fixed, and then saves', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent(), onSave })

      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '18:00' } })
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } })
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(screen.getByTestId('event-slot-error')).toBeInTheDocument()

      // Restore an ORDERED window — flipping just one bound back would leave the pair
      // still inverted or zero-length.
      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '09:00' } })
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '18:00' } })
      await waitFor(() =>
        expect(screen.queryByTestId('event-slot-error')).toBeNull(),
      )

      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalled())
    })
  })

  /**
   * #1482: a non-`rr-then-ko` event holds AT MOST ONE reservation. The editor declines
   * to build a second one (Add disables, with its reason in visible text) — but a
   * director can still reach an over-cap draft by flipping the Basics draw-type picker
   * on an event that already holds two (the `rr-then-ko` case, which legally holds
   * many). Saving THAT must fail in the form, red on the Reservations tab, in the
   * client's own words — never by freezing the Basics draw-type select, which would
   * point the director at the wrong tab entirely.
   */
  describe('an over-cap reservation list (#1482)', () => {
    it('disables Add, names the reason, and leaves Remove live once the draft flips off rr-then-ko', async () => {
      eventEditorPage.render({
        event: buildRrThenKoEvent({
          reservations: [
            buildReservation({ id: 'res-a', name: 'Reservation A', position: 0 }),
            buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          ],
        }),
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      expect(eventEditorPage.getAddReservationButton()).toBeEnabled()
      expect(eventEditorPage.queryReservationsCapNotice()).toBeNull()

      // The draw-type picker is on Basics — leave Reservations to flip it, exactly as
      // a director would, then come back to see Add react to the unsaved change.
      await userEvent.click(eventEditorPage.getSectionTab('Basics'))
      await eventEditorPage.chooseDrawType('Round robin')
      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))

      expect(eventEditorPage.getAddReservationButton()).toBeDisabled()
      expect(eventEditorPage.queryReservationsCapNotice()).not.toBeNull()
      for (const button of eventEditorPage.getRemoveReservationButtons()) {
        expect(button).toBeEnabled()
      }
    })

    it('refuses the save, red on Reservations, and sends nothing', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildRrThenKoEvent({
          reservations: [
            buildReservation({ id: 'res-a', name: 'Reservation A', position: 0 }),
            buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          ],
        }),
        onSave,
      })

      await eventEditorPage.chooseDrawType('Round robin')
      await userEvent.click(eventEditorPage.getSaveButton())

      // Nothing left the room.
      expect(onSave).not.toHaveBeenCalled()
      // A message on a tab you cannot see is indistinguishable from a button that does
      // nothing — Reservations is where the offending list actually is.
      expect(eventEditorPage.getSectionTab('Reservations')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      const error = eventEditorPage.queryReservationsCapError()
      expect(error).not.toBeNull()
      // The client's OWN sentence — never the server's raw detail string
      // (`DEFINITION_OF_COMPLETE`), and it names the count actually held. A bare '2'
      // would NOT prove that: the server's sentence ends "and this one holds 2" too,
      // so the assertion has to name a fragment only the client's wording carries.
      expect(error).toHaveTextContent('it currently holds 2')
      // …and ONLY that one. The Add button's cap notice says the same rule in weaker
      // words ("this event can hold only one reservation") without naming the count
      // held or the way down to one, so stacking it directly above the red would bury
      // the sentence that actually helps. Same principle as the freeze notice
      // suppressing it: one dead button, one explanation, said once.
      expect(eventEditorPage.queryReservationsCapNotice()).toBeNull()
      // …and the BUTTON is still dead. Suppressing the notice must not suppress the
      // cap: Add disables from the FIRST reservation while this refusal only exists
      // past the second, so a single flag serving both would re-enable Add at two —
      // offering a third reservation on the very screen that just refused to save two.
      expect(eventEditorPage.getAddReservationButton()).toBeDisabled()
    })

    // Both refusals fire at once — the array-level cap AND a per-row blank name — and
    // both must still be visible. A read that only checked `errors.reservations.message`
    // (the shape when the cap is the ONLY reservations error) would go blank the moment
    // a row error joins it, because RHF nests the array-level message under `.root`
    // once ANY per-row error exists beside it.
    it('shows the cap message alongside a per-row name error when both fire together', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildRrThenKoEvent({
          reservations: [
            buildReservation({ id: 'res-a', name: '' }),
            buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          ],
        }),
        onSave,
      })

      await eventEditorPage.chooseDrawType('Round robin')
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getReservationNameErrors()).toEqual(['Name is required.'])
      expect(eventEditorPage.queryReservationsCapError()).not.toBeNull()
    })

    // The refusal must not OUTLIVE its condition. Its own second remedy is "switch the
    // draw type to rr-then-ko", and taking it used to leave the red alert on screen
    // insisting the draw type is not rr-then-ko — false at the moment it was rendered,
    // beside an Add button that had just re-enabled. RHF revalidates the field that
    // CHANGED, never a sibling, so the array-level error raised at `['reservations']`
    // survives a `drawType` edit; the section re-derives the condition instead of
    // trusting that stale error object.
    it('clears the cap refusal when the director takes its own rr-then-ko remedy', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildRrThenKoEvent({
          reservations: [
            buildReservation({ id: 'res-a', name: 'Reservation A', position: 0 }),
            buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          ],
        }),
        onSave,
      })

      await eventEditorPage.chooseDrawType('Round robin')
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.queryReservationsCapError()).not.toBeNull()

      // The remedy the message itself offers, taken on the tab it points at.
      await userEvent.click(eventEditorPage.getSectionTab('Basics'))
      await eventEditorPage.chooseDrawType('Round-robin then knockout')
      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))

      // The red alert is gone, and so is the notice: at rr-then-ko the cap does not
      // apply at all, so neither story about it may be on screen.
      expect(eventEditorPage.queryReservationsCapError()).toBeNull()
      expect(eventEditorPage.queryReservationsCapNotice()).toBeNull()
      // …and Add is live again, because two reservations are legal for this draw type.
      expect(eventEditorPage.getAddReservationButton()).toBeEnabled()

      // The display and the resolver must agree: the save the message promised now
      // goes through. Without this the gate could clear the alert while `handleSubmit`
      // still refused, which is a worse lie than the one it was written to fix.
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(onSave).toHaveBeenCalled()
    })

    // The cap's copy is the ONLY instruction the feature gives, and it has to name
    // something the director can actually pick. `rr-then-ko` is the wire token; the
    // Basics picker renders the label the `draw_types` table serves ("Round-robin then
    // knockout"), so a message naming the token sends the director hunting for an
    // option that is not on the menu. Asserted on BOTH surfaces — the notice beside the
    // dead Add button, and the red refusal — because they are separate strings in
    // separate files and only one of them was wrong first.
    it('never names the wire token in either the cap notice or the refusal', async () => {
      const onSave = vi.fn()
      eventEditorPage.render({
        event: buildRrThenKoEvent({
          reservations: [
            buildReservation({ id: 'res-a', name: 'Reservation A', position: 0 }),
            buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          ],
        }),
        onSave,
      })

      // BEFORE the save, the NOTICE is the surface on show: `capError` does not exist
      // until a submit has run, so `showCapNotice` is still true even at two.
      await eventEditorPage.chooseDrawType('Round robin')
      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      const notice = eventEditorPage.queryReservationsCapNotice()
      expect(notice).not.toBeNull()
      expect(notice?.textContent).not.toContain('rr-then-ko')
      expect(notice?.textContent).toContain('round-robin-then-knockout')

      // AFTER the refused save, the RED ERROR takes over and the notice steps aside.
      await userEvent.click(eventEditorPage.getSaveButton())
      expect(onSave).not.toHaveBeenCalled()
      const error = eventEditorPage.queryReservationsCapError()
      expect(error).not.toBeNull()
      expect(error?.textContent).not.toContain('rr-then-ko')
      expect(error?.textContent).toContain('round-robin-then-knockout')
      // …and it still names the count actually held, which is what makes it actionable.
      // The client's own phrasing, not a bare digit the server's sentence also carries.
      expect(error).toHaveTextContent('it currently holds 2')
    })

    // The freeze notice, not this one, once the event is drawn — a director locked out
    // by a cut draw is told to delete the draw first (the actionable instruction); the
    // cap notice would be a second, less useful story about the very same dead button.
    //
    // **The draw type here must NOT be `rr-then-ko`.** This test used to build one, and
    // that made it unfalsifiable: `capped` is already false for an `rr-then-ko` event on
    // its draw-type clause alone, so the `!frozen` clause this test exists to pin was
    // never the reason the notice was absent, and dropping `!frozen` left it green. A
    // cut ROUND-ROBIN holding two legacy reservations (data only reachable pre-#1482) is
    // the state that discriminates: every other clause of `capped` is true, so the
    // notice is absent if and only if the freeze suppressed it.
    //
    // No save is submitted, deliberately. `capError` does not exist until a submit has
    // run, so `showCapNotice` reduces to `capped` here — leaving the freeze as the only
    // thing that can suppress the notice, rather than letting `!capError` do it and pass
    // the test for the wrong reason.
    it('shows no cap notice once the draw is cut, even while over cap', async () => {
      eventEditorPage.render({
        event: buildEvent({
          id: 'ev-1',
          drawType: 'round-robin',
          reservations: [
            buildReservation({ id: 'res-a', name: 'Reservation A', position: 0 }),
            buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          ],
          fixtures: [buildFixture({ groupId: groupIdFor('res-a') })],
        }),
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))

      expect(eventEditorPage.getAddReservationButton()).toBeDisabled()
      // The freeze's own notice IS on screen — the one actionable sentence, said once.
      expect(screen.getByTestId('reservations-frozen-notice')).toBeInTheDocument()
      expect(eventEditorPage.queryReservationsCapNotice()).toBeNull()
    })
  })

  /**
   * THE data-loss half — and the half that matters most, because client validation
   * only ever prevents the refusals we already know about. Whatever the *next*
   * unknown 422 is, it must not silently eat somebody's work: the sheet stays open,
   * the draft stays in it, and the organizer is told.
   *
   * Told **in our words**. The banner used to print `ApiError.detail`, which for a
   * 422 is Pydantic's: *"String should have at most 255 characters"* — the wire's
   * vocabulary, a constraint rather than an instruction, and no clue which of eight
   * fields it is about. `DEFINITION_OF_COMPLETE.md`: *"Raw API detail strings never
   * reach the UI."*
   */
  describe('a save the server refuses', () => {
    const rejectWith = (error: unknown) => vi.fn().mockRejectedValue(error)

    /** FastAPI's real 422 body — a `detail` ARRAY of pydantic errors. The editor is
     * handed the whole `ApiError`, `body` included, because the `loc` in there is the
     * one thing it could not have guessed: which field. */
    const pydantic422 = (field: string, msg: string) =>
      new ApiError(422, msg, 'create event', {
        detail: [{ type: 'string_too_long', loc: ['body', field], msg }],
      })

    it('keeps the sheet OPEN, keeps the draft, and says what happened — in OUR words', async () => {
      const onSave = rejectWith(
        pydantic422('name', 'String should have at most 255 characters'),
      )
      const onClose = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'new-1', name: 'Open Singles' }),
        onSave,
        onClose,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      // NOT Pydantic's sentence…
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent(
        'String should have at most',
      )
      // …but the field it named, in the words the form puts above that field.
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'The Event name was rejected. Check that field and try again.',
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'your changes are still here',
      )
      // Still open — and it is the EDITOR that has not closed, not merely a parent
      // that happens to have kept it mounted: nothing asked for it to close.
      expect(eventEditorPage.querySheet()).toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      // …and the work is still in it.
      expect(eventEditorPage.getNameInput()).toHaveValue('Open Singles')
    })

    it('words a 422 it cannot map to a field generically — still never pydantic’s', async () => {
      const onSave = rejectWith(
        pydantic422('seeding_policy', 'Input should be a valid string'),
      )
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "Some of this event's details were rejected",
      )
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent('Input should be')
    })

    it('says a 5xx is OUR fault — and never blames the organizer’s connection', async () => {
      // THE round-three regression, on this side of the pair: a 500 read out "The server
      // couldn't be reached. Check your connection and try again." The server WAS
      // reached — it answered, with a fault of ours — and that sentence sends the
      // organizer off to debug their wifi over it.
      const onSave = rejectWith(new ApiError(500, null, 'update event'))
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "Couldn't save your changes",
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'Something went wrong on our end. Nothing you did caused it',
      )
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent(
        /connection|couldn't be reached/,
      )
    })

    it('blames the connection only for a request that got NO answer', async () => {
      // The other designed state (`DEFINITION_OF_COMPLETE.md`: 5xx and network-down are
      // distinct). A rejected `fetch` is re-thrown by openapi-fetch, so it lands here as
      // a raw `TypeError` — never as an `ApiError` with a status to read.
      const onSave = rejectWith(new TypeError('Failed to fetch'))
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "The server couldn't be reached. Check your connection and try again.",
      )
      // The work is still here either way — that is the contract, whatever went wrong.
      expect(eventEditorPage.getNameInput()).toHaveValue('Open Singles')
    })

    it('passes on a sentence the server wrote for a HUMAN (ADR-0968 fallback)', async () => {
      // A 403 is not a validator's complaint: its `detail` is prose we wrote, and it
      // is a refusal the client has no copy of its own for. Show it.
      const onSave = rejectWith(
        new ApiError(403, 'You can only modify tournaments you created.', 'update event', {
          detail: 'You can only modify tournaments you created.',
        }),
      )
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'You can only modify tournaments you created.',
      )
    })

    it('reports nothing when the save succeeds', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      expect(eventEditorPage.queryFailure()).toBeNull()
    })

    // **The race.** The editor disables the add/remove-reservation controls of an event
    // whose draw is cut (ADR-0786) — but "is the draw cut?" was answered when the page
    // loaded. A director with two tabs open, or a co-director across the hall, can cut one
    // after that, and this sheet's live-looking Add button becomes a change the server
    // will refuse. So the 409 has to land somewhere designed, and it does: the same inline
    // banner, with the SERVER's sentence, which is the only copy that knows which group
    // went missing and that the way out is to delete the draw.
    //
    // That sentence survives *because* `saveFailure` classifies a 409 as `refused` (prose
    // the API wrote for a human) rather than as `invalid` (a validator's machine words,
    // which are never shown). This test is what stops a future tidy-up from collapsing
    // the two.
    it('surfaces a group-set 409 with the server’s own sentence — the cut-draw race', async () => {
      // The server's sentence, byte for byte (`_group_set_frozen_detail`,
      // `api/app/tournament_events.py`), because that is what this test is standing in
      // for. It stopped offering "re-identify" as a third thing to do when the group ids
      // moved server-side (ADR 20260801): re-identifying a group is no longer a payload a
      // client can send, so it is no longer a refusal a client can meet.
      const refusal =
        "This event's draw is already cut, so its set of groups is frozen: “Group B” " +
        'already has fixtures drawn into it, which this change would leave pointing at ' +
        "a group that no longer exists. A reservation's tables, its time and its name " +
        'can all still be changed. To add or remove a group, remove the draw ' +
        'first, then cut it again.'
      const onSave = rejectWith(
        new ApiError(409, refusal, 'update event', { detail: refusal }),
      )
      const onClose = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', reservations: [buildReservation()] }),
        onSave,
        onClose,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(refusal)
      // Not swallowed, not a raw crash, and not a closed sheet over a discarded draft.
      expect(eventEditorPage.querySheet()).toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'your changes are still here',
      )
    })
  })

  /**
   * The conflict banner and its deliberate override (#1499). A coded 409
   * (`event_version_conflict`) is a DIFFERENT news than the plain-string 409s above
   * (the draw freezes) — this event was written elsewhere since the sheet was
   * opened — and it gets its own copy and its own recovery: a button the director
   * presses on purpose, which re-sends the same draft against the FRESH version
   * (`currentLockVersion`), never the one the sheet opened on.
   */
  describe('the conflict banner and its override (#1499)', () => {
    /** The real shape, byte for byte (`_event_version_conflict`,
     * `api/app/tournaments.py`). */
    const conflictError = new ApiError(409, null, 'update event', {
      detail: {
        code: 'event_version_conflict',
        message: 'server sentence — never shown, see save-failure.test.ts',
      },
    })

    it('keeps the sheet open, keeps the draft, and offers the override — never the server’s sentence', async () => {
      const onSave = vi.fn().mockRejectedValue(conflictError)
      const onClose = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', lockVersion: 2 }),
        currentLockVersion: 3,
        onSave,
        onClose,
      })

      await userEvent.clear(eventEditorPage.getNameInput())
      await userEvent.type(eventEditorPage.getNameInput(), 'Renamed while stale')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(eventEditorPage.queryFailure()).toBeInTheDocument())
      // OUR copy (ADR-0968) — never the server's sentence, which `save-failure.test.ts`
      // already pins is captured but not spoken.
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'This event has changed since you opened it',
      )
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent(
        'server sentence',
      )
      expect(eventEditorPage.querySheet()).toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      expect(eventEditorPage.getNameInput()).toHaveValue('Renamed while stale')
      expect(eventEditorPage.getOverrideButton()).toBeInTheDocument()
    })

    it('the override re-sends the draft against the FRESH version, not the one the sheet opened on', async () => {
      const onSave = vi.fn().mockRejectedValueOnce(conflictError).mockResolvedValue(undefined)
      const onClose = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', lockVersion: 2 }),
        // The version this sheet would read on a FRESH GET — deliberately different
        // from the event's own frozen 2, which is the whole point of the prop.
        currentLockVersion: 5,
        onSave,
        onClose,
      })

      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.getOverrideButton()).toBeInTheDocument())

      await userEvent.click(eventEditorPage.getOverrideButton())

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
      // THE assertion: the second call carries `currentLockVersion` (5), never
      // `event.lockVersion` (2) — reusing the frozen prop would conflict forever.
      expect(onSave).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ lockVersion: 5 }),
      )
      // The override saved and closed, same as any other successful save — `force`,
      // because the form is still dirty at that instant and the discard guard must
      // not challenge work that has just been saved.
      await waitFor(() => expect(onClose).toHaveBeenCalledWith({ force: true }))
    })

    it('disables the override — and says why — when the event was deleted elsewhere', async () => {
      const onSave = vi.fn().mockRejectedValue(conflictError)
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', lockVersion: 2 }),
        // `null`: the reconciled tournament no longer lists this event at all.
        currentLockVersion: null,
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(eventEditorPage.queryFailure()).toBeInTheDocument())
      expect(eventEditorPage.queryOverrideButton()).not.toBeInTheDocument()
      expect(eventEditorPage.queryConflictDeletedNotice()).toBeInTheDocument()
    })

    it('renders no override for a VIEWER (canEdit: false) — a reader has nothing to overwrite with', async () => {
      const onSave = vi.fn().mockRejectedValue(conflictError)
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', lockVersion: 2 }),
        currentLockVersion: 3,
        canEdit: false,
        onSave,
      })

      // A viewer has no Save button to press in the first place — the banner (and
      // therefore the override) can only ever be reached by a save this editor
      // itself fired, which `canEdit: false` never does. Asserted directly: no
      // override renders even if a failure were somehow on screen.
      expect(eventEditorPage.querySaveButton()).not.toBeInTheDocument()
      expect(eventEditorPage.queryOverrideButton()).not.toBeInTheDocument()
    })
  })

  /**
   * Keyboard focus on a refused save (#1538). Before this, pressing Save disabled
   * the element that held focus, the browser dropped focus to `<body>`, and
   * nothing moved it back — so a keyboard user reached the banner's action only by
   * tabbing past the whole form from the sheet's Close button. jsdom cannot prove
   * the visible-focus-indicator or true-Tab-order criteria (`getComputedStyle`
   * ignores `box-shadow`, and `userEvent.tab()` does not model Radix's
   * `FocusScope`); the Playwright suite covers those.
   */
  describe('focus moves to the failure banner on a refusal (#1538)', () => {
    const conflictError = new ApiError(409, null, 'update event', {
      detail: {
        code: 'event_version_conflict',
        message: 'server sentence — never shown, see save-failure.test.ts',
      },
    })

    it('focuses the banner when the server refuses a save, and keeps it out of the tab order (`tabindex="-1"`)', async () => {
      const onSave = vi.fn().mockRejectedValue(new ApiError(500, null, 'update event'))
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(eventEditorPage.queryFailure()).toHaveFocus())
      expect(eventEditorPage.queryFailure()).toHaveAttribute('tabindex', '-1')
    })

    it('moves focus to the banner again on a second refused save', async () => {
      const onSave = vi.fn().mockRejectedValue(new ApiError(500, null, 'update event'))
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.queryFailure()).toHaveFocus())

      // The director tabs away before trying again — the second refusal must pull
      // focus back, not just keep it wherever the first one left it.
      eventEditorPage.getNameInput().focus()
      expect(eventEditorPage.queryFailure()).not.toHaveFocus()

      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.queryFailure()).toHaveFocus())
    })

    it('moves focus to the banner on a refused override — the conflict arm', async () => {
      const onSave = vi.fn().mockRejectedValue(conflictError)
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', lockVersion: 2 }),
        currentLockVersion: 5,
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() =>
        expect(eventEditorPage.getOverrideButton()).toBeInTheDocument(),
      )
      eventEditorPage.getNameInput().focus()

      await userEvent.click(eventEditorPage.getOverrideButton())

      await waitFor(() => expect(eventEditorPage.queryFailure()).toHaveFocus())
    })

    it('moves focus to the banner for the deleted-elsewhere arm, which carries a sentence and no button', async () => {
      const onSave = vi.fn().mockRejectedValue(conflictError)
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', lockVersion: 2 }),
        currentLockVersion: null,
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(eventEditorPage.queryFailure()).toHaveFocus())
      expect(eventEditorPage.queryConflictDeletedNotice()).toBeInTheDocument()
    })

    it('moves no focus on a fresh open with no failure', () => {
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }) })

      expect(eventEditorPage.queryFailure()).toBeNull()
    })
  })

  /**
   * **Who owns a reservation id, from the card to the request body** (ADR 20260801).
   *
   * The section's own tests prove the form holds the right *entries*; these prove the
   * thing only the editor can, and the thing that 422s if it is wrong: what
   * `eventToCreateBody` / `eventToUpdateBody` make of them. `onSave` receives exactly the
   * object the page maps, so mapping it here is what the client would really put on the
   * wire — and a test that stopped at form state would pass just as happily against a
   * mapper that put the ids back.
   *
   * The two failures are opposite and both silent. An id on a NEW reservation is a 422
   * (`extra_forbidden` on `body.reservations[i].id`) — the whole save refused, for a key
   * the director never typed. A missing id on a STORED reservation is worse than a
   * refusal: the PATCH is an id-keyed diff, so an uncited reservation is REMOVED, and its
   * mapped group's fixtures go with it.
   */
  describe('the reservations a save puts on the wire', () => {
    const addAReservation = async () => {
      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.click(screen.getByRole('button', { name: 'Add reservation' }))
    }

    it('sends an added reservation with NO id, and still cites the stored one', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        // rr-then-ko: the ADD this test drives leaves the event holding two
        // reservations, which #1482 caps everywhere else.
        event: buildEvent({
          id: 'ev-1',
          drawType: 'rr-then-ko',
          qualifiersPerGroup: 2,
          reservations: [buildReservation({ id: 'res-1' })],
        }),
        onSave,
      })

      await addAReservation()
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      const reservations = eventToUpdateBody(onSave.mock.calls[0][0]).reservations ?? []
      expect(reservations).toHaveLength(2)
      // The reservation the event already has, cited — which keeps it (and its draw).
      expect(reservations[0]).toMatchObject({ id: 'res-1', name: 'Reservation A' })
      // …and the new one, with no id key at all for the server to trip over.
      expect('id' in reservations[1]).toBe(false)
      expect(reservations[1].name).toBe('Reservation B')
    })

    // A rename is the case a mapper is most likely to get wrong, because it is the one
    // where the reservation's words all change: it must still cite the id, or the
    // director's "Reservation A → Morning Reservation" arrives as one removal and one
    // insertion.
    it('keeps citing a stored reservation the director has just renamed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1', reservations: [buildReservation({ id: 'res-1' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      fireEvent.change(screen.getByLabelText('Reservation name'), {
        target: { value: 'Morning Reservation' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(eventToUpdateBody(onSave.mock.calls[0][0]).reservations).toEqual([
        expect.objectContaining({ id: 'res-1', name: 'Morning Reservation' }),
      ])
    })

    // The create verb has no id arm at ALL (`ReservationWrite`), so a brand-new event's
    // reservations carry none — the server mints one apiece and hands them back on the
    // response the page then renders.
    it('creates an event whose reservations carry no ids whatsoever', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      // Named, because a blank name is refused in the form and nothing would be sent —
      // the resolver is doing its job, and this test is about a different one.
      eventEditorPage.render({
        event: {
          ...emptyEvent(buildTournament()),
          name: 'New Event',
          // rr-then-ko: two ADDED reservations is exactly what #1482 caps for every
          // other draw type, and this test's own claim is about the create verb's id
          // shape, not about which draw type was picked.
          drawType: 'rr-then-ko',
          qualifiersPerGroup: 2,
        },
        onSave,
      })

      await addAReservation()
      await addAReservation()
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      const reservations = eventToCreateBody(onSave.mock.calls[0][0]).reservations ?? []
      expect(reservations).toHaveLength(2)
      for (const reservation of reservations) {
        expect('id' in reservation).toBe(false)
        expect('position' in reservation).toBe(false)
      }
    })
  })

  // The two freezes, wired end to end through the real sheet — the sections own the
  // controls, the editor owns the derivation, and this is the seam between them. Both
  // are read off the event's `fixtures`, which is not a form field: nothing on this
  // sheet can cut or delete a draw.
  describe('an event whose draw is cut', () => {
    const drawn = () =>
      buildEvent({
        id: 'ev-1',
        drawType: 'round-robin',
        reservations: [buildReservation()],
        fixtures: [buildFixture({ groupId: groupIdFor('res-1') })],
      })

    it('freezes the draw type on Basics and the group set on Reservations', async () => {
      eventEditorPage.render({ event: drawn() })

      // Basics is the tab it opens on.
      expect(
        screen.getByRole('combobox', { name: 'Draw type' }),
      ).toBeDisabled()
      // …while the format beside it — which no fixture depends on — stays live.
      expect(screen.getByRole('combobox', { name: 'Format' })).toBeEnabled()

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      expect(screen.getByRole('button', { name: 'Add reservation' })).toBeDisabled()
      expect(screen.getByRole('button', { name: /^Remove reservation/ })).toBeDisabled()
      expect(screen.getByTestId('reservations-frozen-notice')).toHaveTextContent(
        'Delete the draw',
      )
      // The venue attributes the freeze exists to protect are still editable.
      expect(screen.getByLabelText('Reservation name')).toBeEnabled()
      expect(screen.getByRole('button', { name: 'T1' })).toBeEnabled()
    })

    it('freezes nothing when no draw is cut', async () => {
      eventEditorPage.render({
        event: buildEvent({
          id: 'ev-1',
          drawType: 'rr-then-ko',
          qualifiersPerGroup: 2,
          reservations: [buildReservation()],
        }),
      })

      expect(screen.getByRole('combobox', { name: 'Draw type' })).toBeEnabled()

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      expect(screen.getByRole('button', { name: 'Add reservation' })).toBeEnabled()
      expect(screen.getByRole('button', { name: /^Remove reservation/ })).toBeEnabled()
      expect(screen.queryByTestId('reservations-frozen-notice')).toBeNull()
    })
  })

  it('offers delete only for an existing event', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }) })
    expect(eventEditorPage.queryDeleteButton()).toBeInTheDocument()
    expect(eventEditorPage.getSaveButton()).toHaveTextContent('Save changes')
  })

  it('labels a new event and hides delete', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'new-123' }) })
    expect(eventEditorPage.queryDeleteButton()).toBeNull()
    expect(eventEditorPage.getSaveButton()).toHaveTextContent('Create event')
  })

  it('switches sections via the tabs', async () => {
    eventEditorPage.render({ event: buildEvent() })
    await userEvent.click(eventEditorPage.getSectionTab('Match settings'))
    expect(screen.getByRole('switch', { name: 'Rated' })).toBeInTheDocument()
  })

  it('hides save and delete for a non-creator (read-only view)', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), canEdit: false })
    expect(eventEditorPage.querySaveButton()).toBeNull()
    expect(eventEditorPage.queryDeleteButton()).toBeNull()
    expect(eventEditorPage.getDismissButton()).toHaveTextContent('Done')
  })

  // #933 / #934: a client-side rejection must surface inline and keep the panel
  // open with the typed values intact — never close over a silent discard.
  describe('validation keeps the panel open', () => {
    it('rejects an over-long name inline without saving or closing', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'new-1', name: '' }),
        onSave,
        onClose,
      })

      fireEvent.change(eventEditorPage.getNameInput(), {
        target: { value: OVER_LONG_NAME },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(
          eventEditorPage.queryError(/255 characters or fewer/),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      // The typed value is retained, not discarded.
      expect(eventEditorPage.getNameInput()).toHaveValue(OVER_LONG_NAME)
    })

    it('rejects a zero player limit inline', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent(), onSave })

      fireEvent.change(eventEditorPage.getPlayerLimitInput(), {
        target: { value: '0' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() =>
        expect(
          eventEditorPage.queryError(/at least 1, or blank for no cap/),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()
    })

    it('submits a blank player limit as null (no cap)', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ maxPlayers: 64 }), onSave })

      fireEvent.change(eventEditorPage.getPlayerLimitInput(), {
        target: { value: '' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ maxPlayers: null }),
      )
    })

    it('requires an entry fee but accepts a zero fee (free event)', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ entryFee: 45 }), onSave })

      // Blank → required error, no save.
      fireEvent.change(eventEditorPage.getEntryFeeInput(), {
        target: { value: '' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() =>
        expect(
          eventEditorPage.queryError(/Entry fee is required/),
        ).toBeInTheDocument(),
      )
      expect(onSave).not.toHaveBeenCalled()

      // A typed 0 is a legitimate free event — it saves.
      fireEvent.change(eventEditorPage.getEntryFeeInput(), {
        target: { value: '0' },
      })
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ entryFee: 0 }),
      )
    })

    // The two silent-discard fixes met here, and the banner won: a 422's `detail` is a
    // string we do not control (Pydantic's, when it is not one of ours), and
    // DEFINITION_OF_COMPLETE forbids it reaching the UI. So the panel stays open — the
    // protection both fixes were for — but the copy is the classifier's, not the wire's.
    it('surfaces a server 422 and keeps the panel open — in OUR words, not the wire’s', async () => {
      const onSave = vi
        .fn()
        .mockRejectedValue(
          new ApiError(422, 'That name is already taken.', 'save event'),
        )
      const onClose = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ name: 'Open Singles' }),
        onSave,
        onClose,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      await waitFor(() =>
        expect(eventEditorPage.queryFailure()).toBeInTheDocument(),
      )
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        "Some of this event's details were rejected",
      )
      expect(eventEditorPage.queryFailure()).not.toHaveTextContent(
        'That name is already taken.',
      )
      // Rejected: the panel did not close, and the work is still in it.
      expect(onClose).not.toHaveBeenCalled()
      expect(eventEditorPage.getNameInput()).toHaveValue('Open Singles')
    })
  })

  // The overline names what the panel *is*. "Edit event" is addressed to the
  // person in control (ADR 0015, rule 5) — a viewer is being shown an event, not
  // invited to edit one. Both sides are asserted, so the editor's own labels
  // cannot be deleted to satisfy the viewer's.
  describe('the header overline', () => {
    it('says "Edit event" to the creator of an existing event', () => {
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }) })
      expect(eventEditorPage.getOverline()).toHaveTextContent('Edit event')
    })

    it('says "New event" to the creator of a new one', () => {
      eventEditorPage.render({ event: buildEvent({ id: 'new-123' }) })
      expect(eventEditorPage.getOverline()).toHaveTextContent('New event')
    })

    it('says just "Event" to a non-creator', () => {
      eventEditorPage.render({
        event: buildEvent({ id: 'ev-1' }),
        canEdit: false,
      })
      // Exact: "Edit event" would satisfy a substring match on "event".
      expect(eventEditorPage.getOverline()).toHaveTextContent(/^Event$/)
      expect(eventEditorPage.getOverline()).not.toHaveTextContent(/Edit/)
    })
  })

  // The nested-array sub-forms (Eligibility, Reservations) drive the one
  // React-Hook-Form via `useFieldArray` (chore 1e), so add / edit / remove is
  // form state that rides out on Save with the rest of the event — proved here
  // end to end through `onSave`, not just in form state.
  describe('the nested-array sub-forms persist on save', () => {
    const savePayload = (onSave: ReturnType<typeof vi.fn>) =>
      onSave.mock.calls.at(-1)?.[0]

    it('carries an added eligibility rule into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ predicates: [] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Eligibility'))
      // Both the header "Add rule" and the empty-state "Add a rule" are present;
      // the exact name pins the header action.
      await userEvent.click(screen.getByRole('button', { name: 'Add rule' }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).predicates).toHaveLength(1)
    })

    it('carries an added reservation into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ reservations: [] }), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      // Both the header "Add reservation" and the empty-state "Add first
      // reservation" are present; the exact name pins the header action.
      await userEvent.click(screen.getByRole('button', { name: 'Add reservation' }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).reservations).toHaveLength(1)
    })

    it('drops a removed reservation from the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      // The seeded event carries one reservation; removing it must save an empty list.
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.click(screen.getByRole('button', { name: /^Remove reservation/ }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).reservations).toHaveLength(0)
    })

    // A multi-character edit is the discriminating case for the `useFieldArray`
    // wiring: an in-place `update` that remounted the row would drop focus after
    // the first keystroke, and only the first character would land. Keying the
    // row on the stable domain id keeps it mounted, so the whole name persists.
    it('carries a multi-character reservation rename into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ reservations: [buildReservation({ name: 'Reservation A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      const nameInput = screen.getByLabelText('Reservation name')
      await userEvent.clear(nameInput)
      await userEvent.type(nameInput, 'Championship')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).reservations[0].name).toBe('Championship')
    })
  })

  /**
   * The event timezone anchors its wall-clock windows to real instants (ADR
   * 20260719). A new event pre-fills the picker from the browser's resolved zone; the
   * director can change it via the searchable picker; and it rides the saved payload.
   */
  describe('the event timezone (ADR 20260719)', () => {
    afterEach(() => vi.restoreAllMocks())

    /** Point the browser's resolved zone at `zone` for one test — the only way to
     * prove the default *follows the browser* is to move the browser. */
    function stubBrowserZone(zone: string) {
      const real = Intl.DateTimeFormat
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
          const fmt = new real(...args)
          const opts = fmt.resolvedOptions()
          vi.spyOn(fmt, 'resolvedOptions').mockReturnValue({
            ...opts,
            timeZone: zone,
          })
          return fmt
        },
      )
    }

    it("pre-fills a new event's picker and window label from the browser zone", () => {
      stubBrowserZone('Pacific/Auckland')
      eventEditorPage.render({ event: emptyEvent(buildTournament()) })

      expect(
        screen.getByRole('combobox', { name: 'Timezone' }),
      ).toHaveTextContent('Pacific/Auckland')
      expect(screen.getByTestId('event-timezone-label')).toHaveTextContent(
        'Pacific/Auckland',
      )
    })

    it('carries a picked timezone into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({
          id: 'new-1',
          name: 'Open Singles',
          timezone: 'America/Chicago',
        }),
        onSave,
      })

      await userEvent.click(screen.getByRole('combobox', { name: 'Timezone' }))
      await userEvent.type(
        await screen.findByPlaceholderText('Search timezones…'),
        'Denver',
      )
      await userEvent.click(
        await screen.findByRole('option', { name: 'America/Denver' }),
      )
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'America/Denver' }),
      )
    })
  })

  /**
   * The `saving` prop contract (#1231 QA): five rapid clicks on Create event made
   * five identical events, because the button's guard was React Hook Form's
   * `isSubmitting` alone — true only while the `onSave` promise is unsettled — and
   * `isSubmitting` clears before the underlying mutation actually settles (see
   * `saving`'s doc comment on `EventEditorProps`). The route now threads
   * `savingEvent={createEvent.isPending || updateEvent.isPending}` down as `saving`,
   * so the button disables on the union of both.
   *
   * This is deliberately a PROP-CONTRACT test, not a reproduction of the click race
   * itself: the race is a real, confirmed gap between `isSubmitting` going false and
   * the mutation's own `isPending` going false (instrumented and observed directly
   * on the committed DOM during this fix), but nothing yields between those two
   * commits in jsdom — there's no paint/frame boundary the way a real browser has —
   * so no `userEvent`/`fireEvent`/`waitFor`-driven double-click can land inside it
   * deterministically here. What CAN be pinned, and is the thing actually shipped,
   * is that `saving` independently gates the button — proven by driving it directly
   * rather than fishing for a race.
   */
  describe('the pending-mutation gate (#1231 QA)', () => {
    it('stays disabled while `saving` is true, even though nothing is mid-submit', () => {
      // No click happened — `isSubmitting` is false. Only `saving` (the route's
      // `createEvent.isPending || updateEvent.isPending`) is holding the gate, which
      // is exactly the window `isSubmitting` alone missed.
      eventEditorPage.render({ event: buildEvent({ name: 'Open Singles' }), saving: true })

      expect(eventEditorPage.getSaveButton()).toBeDisabled()
    })

    it('is enabled once `saving` clears — the gate is not a stuck one', () => {
      eventEditorPage.render({ event: buildEvent({ name: 'Open Singles' }), saving: false })

      expect(eventEditorPage.getSaveButton()).toBeEnabled()
    })
  })

  /**
   * The #1537 confirmation: a reservation edit that would newly strand an already-
   * placed match gets a consequence-stating confirm in front of the save — never a
   * refusal. `performSave` is the one function both the ordinary submit and the
   * conflict-override funnel through, so intercepting there is what covers both paths
   * with one check (`event-editor.tsx`'s own doc on the split).
   */
  describe('the newly-stranded-match confirmation (#1537)', () => {
    /** A drawn event with ONE reservation (round-robin's #1482 cap — a non-`rr-then-
     * ko` draw type may hold at most one) and one placed, in-progress match on `t1`,
     * under it. */
    const drawnWithPlacement = (overrides: Partial<Parameters<typeof buildFixture>[0]> = {}) =>
      buildDrawnEvent({
        id: 'ev-1',
        reservations: [
          buildReservation({ id: 'res-a', name: 'Reservation A', tableIds: ['t1', 't2'] }),
        ],
        fixtures: [
          buildFixture({
            id: 'fx-1',
            groupId: groupIdFor('res-a'),
            tableId: 't1',
            scheduledStart: '2026-06-13T09:30:00',
            matchId: 'm-1',
            matchStatus: 'in_progress',
            ...overrides,
          }),
        ],
      })

    /** Drive the one edit every test in this block starts from: drop `t1` from
     * Reservation A's tables, which strands `fx-1` (placed on `t1`). */
    const dropT1FromReservationA = async () => {
      await userEvent.click(eventEditorPage.getSectionTab('Reservations'))
      await userEvent.click(reservationCardPage.getSelectedTableToggle('T1'))
    }

    it('does NOT open for a save that touches nothing about reservations', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: drawnWithPlacement(), onSave })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(eventEditorPage.queryStrandConfirm()).not.toBeInTheDocument()
    })

    it('opens on an edit that newly strands a placed match, naming BOTH numbers', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        // `fx-1` is CALLED (`pinnedAt` set), so the confirm's second number is 1.
        event: drawnWithPlacement({
          pinnedAt: '2026-06-13T09:00:00',
          callNotifiedCount: 1,
        }),
        onSave,
      })

      await dropT1FromReservationA()
      await userEvent.click(eventEditorPage.getSaveButton())

      const dialog = await waitFor(() => eventEditorPage.getStrandConfirm())
      expect(dialog).toHaveTextContent('1')
      expect(dialog).toHaveTextContent('called')
      // Nothing sent yet — the confirm gates the write.
      expect(onSave).not.toHaveBeenCalled()
    })

    it('Cancel sends nothing and keeps the sheet — and the edit — intact', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      eventEditorPage.render({ event: drawnWithPlacement(), onSave, onClose })

      await dropT1FromReservationA()
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.queryStrandConfirm()).toBeInTheDocument())

      await userEvent.click(eventEditorPage.getStrandConfirmCancel())

      expect(eventEditorPage.queryStrandConfirm()).not.toBeInTheDocument()
      expect(onSave).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(eventEditorPage.querySheet()).toBeInTheDocument()
      // The edit survives the dismissal — T1 is still deselected.
      expect(reservationCardPage.getTableToggle('T1')).toBeInTheDocument()
    })

    it('"Save anyway" sends the EXACT draft already composed — the edited reservations, unmodified', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      eventEditorPage.render({ event: drawnWithPlacement(), onSave, onClose })

      await dropT1FromReservationA()
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.queryStrandConfirm()).toBeInTheDocument())

      await userEvent.click(eventEditorPage.getStrandConfirmSave())

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      const sent = onSave.mock.calls[0][0] as {
        reservations: { id?: string; tableIds: string[] }[]
      }
      const resA = sent.reservations.find(
        (r: { id?: string; tableIds: string[] }) => r.id === 'res-a',
      )
      expect(resA?.tableIds).toEqual(['t2']) // t1 dropped, exactly as the director left it
      expect(eventEditorPage.queryStrandConfirm()).not.toBeInTheDocument()
      await waitFor(() => expect(onClose).toHaveBeenCalledWith({ force: true }))
    })

    it('does not reopen on a repeat save of an already-stranded match', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        // The server already flags fx-1 as off its reservation — nothing about to
        // change makes that any newer.
        event: drawnWithPlacement({ tableOffReservation: true }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(eventEditorPage.queryStrandConfirm()).not.toBeInTheDocument()
    })

    it('never blocks the save — "Save anyway" is always available, whatever the tournament’s status', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: drawnWithPlacement(),
        onSave,
      })

      await dropT1FromReservationA()
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.queryStrandConfirm()).toBeInTheDocument())
      expect(eventEditorPage.getStrandConfirmSave()).toBeEnabled()
    })

    // The confirmation composes IN FRONT of the existing 409 handling — it must
    // never bypass or replace it. Confirming "Save anyway" against a stale version
    // must still land on the conflict banner, with its own override.
    it('still surfaces the 409 conflict banner after "Save anyway" — the confirmation does not bypass it', async () => {
      const conflictError = new ApiError(409, null, 'update event', {
        detail: {
          code: 'event_version_conflict',
          message: 'server sentence — never shown',
        },
      })
      const onSave = vi.fn().mockRejectedValue(conflictError)
      eventEditorPage.render({
        event: drawnWithPlacement(),
        currentLockVersion: 3,
        onSave,
      })

      await dropT1FromReservationA()
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.queryStrandConfirm()).toBeInTheDocument())
      await userEvent.click(eventEditorPage.getStrandConfirmSave())

      await waitFor(() => expect(eventEditorPage.queryFailure()).toBeInTheDocument())
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'This event has changed since you opened it',
      )
      expect(eventEditorPage.getOverrideButton()).toBeInTheDocument()
    })

    // Review repair: `performSave` used to clear `failure` only inside `doSave`,
    // which the stranding branch never reaches — so a banner from an EARLIER,
    // unrelated refusal stayed on screen underneath the new confirmation,
    // wrongly implying THIS attempt had already failed too.
    it('clears a stale failure banner from an earlier refusal before opening the strand confirmation', async () => {
      const onSave = vi.fn().mockRejectedValueOnce(new ApiError(500, null, 'update event'))
      eventEditorPage.render({ event: drawnWithPlacement(), onSave })

      // First attempt: an ordinary save, nothing about reservations touched,
      // that fails — the failure banner renders.
      await userEvent.click(eventEditorPage.getSaveButton())
      await waitFor(() => expect(eventEditorPage.queryFailure()).toBeInTheDocument())

      // Now edit the reservation to newly strand `fx-1`, and save again.
      await dropT1FromReservationA()
      await userEvent.click(eventEditorPage.getSaveButton())

      // The confirmation opens, and the STALE banner from the first attempt is
      // gone: this attempt has not failed, it is merely paused on a question.
      await waitFor(() => expect(eventEditorPage.queryStrandConfirm()).toBeInTheDocument())
      expect(eventEditorPage.queryFailure()).not.toBeInTheDocument()
    })
  })
})
