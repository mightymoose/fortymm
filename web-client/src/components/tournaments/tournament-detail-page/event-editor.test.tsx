import { fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ApiError } from '@/api/client'
import { screen, waitFor } from '@/test/utilities'

import { buildEvent, buildPool } from '../data/seed.factory'
import { eventEditorPage } from './event-editor.page'

// A name genuinely past the server's VARCHAR(255) limit — the #933 case. A short
// name would sail through the client schema and prove nothing.
const OVER_LONG_NAME = 'A'.repeat(300)

describe('EventEditor', () => {
  it('saves the working draft and closes on success', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    eventEditorPage.render({
      event: buildEvent({ name: 'Open Singles' }),
      onSave,
      onOpenChange,
    })

    await userEvent.click(eventEditorPage.getSaveButton())
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Open Singles' }),
      ),
    )
    // The panel closes only after the save resolves.
    expect(onOpenChange).toHaveBeenCalledWith(false)
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
      const onOpenChange = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ id: 'new-1', name: '' }),
        onSave,
        onOpenChange,
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
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
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

    it('surfaces a server 422 inline and keeps the panel open', async () => {
      const onSave = vi
        .fn()
        .mockRejectedValue(
          new ApiError(422, 'That name is already taken.', 'save event'),
        )
      const onOpenChange = vi.fn()
      eventEditorPage.render({
        event: buildEvent({ name: 'Open Singles' }),
        onSave,
        onOpenChange,
      })

      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(
        await screen.findByText('That name is already taken.'),
      ).toBeInTheDocument()
      // Rejected: the panel did not close.
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
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

  // The nested-array sub-forms (Eligibility, Table pools) drive the one
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

    it('carries an added table pool into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({ event: buildEvent({ pools: [] }), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      // Both the header "Add pool" and the empty-state "Add first pool" are
      // present; the exact name pins the header action.
      await userEvent.click(screen.getByRole('button', { name: 'Add pool' }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).pools).toHaveLength(1)
    })

    it('drops a removed table pool from the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      // The seeded event carries one pool; removing it must save an empty list.
      eventEditorPage.render({ event: buildEvent(), onSave })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      await userEvent.click(screen.getByRole('button', { name: 'Remove pool' }))
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).pools).toHaveLength(0)
    })

    // A multi-character edit is the discriminating case for the `useFieldArray`
    // wiring: an in-place `update` that remounted the row would drop focus after
    // the first keystroke, and only the first character would land. Keying the
    // row on the stable domain id keeps it mounted, so the whole name persists.
    it('carries a multi-character pool rename into the saved event', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      eventEditorPage.render({
        event: buildEvent({ pools: [buildPool({ name: 'Pool A' })] }),
        onSave,
      })

      await userEvent.click(eventEditorPage.getSectionTab('Table pools'))
      const nameInput = screen.getByLabelText('Pool name')
      await userEvent.clear(nameInput)
      await userEvent.type(nameInput, 'Championship')
      await userEvent.click(eventEditorPage.getSaveButton())

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(savePayload(onSave).pools[0].name).toBe('Championship')
    })
  })
})
