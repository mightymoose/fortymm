import userEvent from '@testing-library/user-event'

import { ApiError } from '@/api/client'
import { screen, waitFor } from '@/test/utilities'

import { buildEvent, buildPredicate } from '../data/seed.factory'
import { eventEditorPage } from './event-editor.page'

describe('EventEditor', () => {
  it('saves the working draft', async () => {
    const onSave = vi.fn()
    eventEditorPage.render({ event: buildEvent({ name: 'Open Singles' }), onSave })

    await userEvent.click(eventEditorPage.getSaveButton())
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Open Singles' }),
    )
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

    it('refuses a CLEARED player limit — the zero that goes on the wire', async () => {
      // The control sets `Number(e.target.value)`, and `Number('')` is **0** — so an
      // emptied box is a zero-player event, which the server refuses (`gt=0`). It used
      // to go anyway, and come back a 422.
      const onSave = vi.fn()
      eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }), onSave })

      await userEvent.clear(eventEditorPage.getPlayerLimitInput())
      await userEvent.click(eventEditorPage.getSaveButton())

      expect(onSave).not.toHaveBeenCalled()
      expect(eventEditorPage.getPlayerLimitInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(
        eventEditorPage.queryFieldError('The player limit must be at least 1.'),
      ).toBeInTheDocument()
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
      const onOpenChange = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'new-1', name: 'Open Singles' }),
        onSave,
        onOpenChange,
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
      expect(onOpenChange).not.toHaveBeenCalled()
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
})
