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
   * THE data-loss half — and the half that matters most, because client validation
   * only ever prevents the refusals we already know about. Whatever the *next*
   * unknown 422 is, it must not silently eat somebody's work: the sheet stays open,
   * the draft stays in it, and the organizer is told.
   */
  describe('a save the server refuses', () => {
    const rejectWith = (error: unknown) => vi.fn().mockRejectedValue(error)

    it('keeps the sheet OPEN, keeps the draft, and shows what happened', async () => {
      const onSave = rejectWith(
        new ApiError(422, 'String should have at most 255 characters', 'create event'),
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
      // The server's own words about the event, and the promise that nothing was
      // binned. (The predecessor showed neither: the sheet closed, the event was
      // never created, and every field the organizer had typed was gone.)
      expect(eventEditorPage.queryFailure()).toHaveTextContent(
        'String should have at most 255 characters',
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

    it('speaks plainly about a failure that is not about the event', async () => {
      // A 5xx / an outage is about the request, not about anything the organizer
      // typed — so it does not get a server sentence they cannot act on.
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
        "The server couldn't be reached",
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
