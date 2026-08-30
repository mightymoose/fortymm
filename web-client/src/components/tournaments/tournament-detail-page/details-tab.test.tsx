import userEvent from '@testing-library/user-event'
import { act } from 'react'

import { ApiError } from '@/api/client'
import { UNBREAKABLE_VENUE_NAME } from '@/mocks/factories/tournaments/tournament.factory'
import { fireEvent, screen, waitFor } from '@/test/utilities'

import { buildAddress, buildTournament } from '../data/seed.factory'
import { detailsTabPage } from './details-tab.page'

/** Drain the microtask React Hook Form's async resolver settles one tick after
 * a `fireEvent.change` — the re-render that shows the Save button (or the
 * field's error) lands there, outside the event's own act window. `userEvent`
 * drains it as part of its own await; `fireEvent` does not. */
const flush = async () => {
  await act(async () => {})
}

/**
 * ⚠️ The string that must NEVER be on screen. It is what FastAPI really answers
 * an over-long `TournamentUpdate.name` with — Pydantic's own prose, in the wire's
 * vocabulary. `DEFINITION_OF_COMPLETE.md`: "Raw API detail strings never reach
 * the UI."
 */
const PYDANTIC = 'String should have at most 255 characters'

/** FastAPI's real 422 body for it: a `detail` ARRAY of `{loc, msg}`. */
const refusedName = new ApiError(422, PYDANTIC, 'update tournament', {
  detail: [{ type: 'string_too_long', loc: ['body', 'name'], msg: PYDANTIC }],
})

const refusedDescription = new ApiError(422, PYDANTIC, 'update tournament', {
  detail: [
    { type: 'string_too_long', loc: ['body', 'description'], msg: PYDANTIC },
  ],
})

/** A nested-address 422 — the wire's own shape for a refused venue component. */
const refusedAddress = new ApiError(422, PYDANTIC, 'update tournament', {
  detail: [
    { type: 'string_too_long', loc: ['body', 'address', 'postal'], msg: PYDANTIC },
  ],
})

/** The client-owned wording of each refusal, as `saveFailureMessage` builds it
 * against `TOURNAMENT_SAVE_TARGET` — asserted verbatim so a wording regression
 * shows here, not in QA. */
const NAME_REFUSAL = 'The Name was rejected. Check that field and try again.'
const DESCRIPTION_REFUSAL =
  'The Description was rejected. Check that field and try again.'
const ADDRESS_REFUSAL =
  'The Venue address was rejected. Check that field and try again.'
const FIELDLESS_REFUSAL =
  "Some of this tournament's details were rejected. Check the fields and try again."
const FAULTED_REFUSAL =
  'Something went wrong on our end. Nothing you did caused it — try again in a moment.'
const OFFLINE_REFUSAL =
  "The server couldn't be reached. Check your connection and try again."

describe('DetailsTab', () => {
  it('reveals save only after an edit, then commits the draft', async () => {
    const onUpdate = vi.fn()
    detailsTabPage.render({
      tournament: buildTournament({ name: 'Bay Area Open 2026' }),
      onUpdate,
    })
    expect(detailsTabPage.querySaveButton()).toBeNull()

    await userEvent.type(detailsTabPage.getNameInput(), '!')
    const save = detailsTabPage.querySaveButton()
    expect(save).toBeInTheDocument()

    await userEvent.click(save!)
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bay Area Open 2026!' }),
    )
  })

  it('reverts the draft back to the committed tournament', async () => {
    detailsTabPage.render({
      tournament: buildTournament({ name: 'Bay Area Open 2026' }),
    })

    await userEvent.type(detailsTabPage.getNameInput(), '!')
    expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026!')

    await userEvent.click(detailsTabPage.getRevertButton())
    expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026')
    expect(detailsTabPage.querySaveButton()).toBeNull()
  })

  // Status is not an editable field (ADR-0017): it moves only across a guarded
  // edge, so this tab offers no way to set one. The four-way toggle that used to
  // live here could ask for `draft → archived`, an edge the server does not have
  // — and once `status` left `TournamentUpdate`, it could not even ask for a
  // legal one: it was a control that did nothing.
  it('offers the OWNER no way to set a status directly', () => {
    detailsTabPage.render({
      tournament: buildTournament({ status: 'draft' }),
      canEdit: true,
    })

    expect(detailsTabPage.queryStatusField()).toBeNull()
    // `ToggleGroupItem` renders `role="radio"`, not `button` — sweep for what the
    // control actually was, or its removal would go unproven.
    expect(detailsTabPage.queryAllRadios()).toHaveLength(0)
    expect(screen.queryByText('Published')).toBeNull()
  })

  // The form's furniture, which only the organizer gets. Paired with the
  // read-only case below so neither can be satisfied by deleting the feature: an
  // assertion that a viewer sees no hint would also pass if the hint were ripped
  // out of the form altogether, which is not the change.
  it('marks Name required and explains the description to the creator', () => {
    detailsTabPage.render({ tournament: buildTournament() })
    expect(detailsTabPage.getNameLabelText()).toBe('Name*')
    expect(detailsTabPage.queryDescriptionHint()).toBeInTheDocument()
  })

  it('renders no required asterisk and no hint for a non-creator', () => {
    detailsTabPage.render({ tournament: buildTournament(), canEdit: false })
    // The label stays — it names the value. The asterisk is what goes: it marks
    // a field you must complete, and a reader completes nothing (ADR 0015).
    expect(detailsTabPage.getNameLabelText()).toBe('Name')
    expect(detailsTabPage.queryDescriptionHint()).toBeNull()
    expect(screen.queryByText('*')).toBeNull()
  })

  // The guard test of ADR 0015: a non-owner gets a rendering of the data, never
  // a form wearing a disabled costume. `queryAllByRole` still finds a *disabled*
  // control, so this fails against a `disabled={!canEdit}` editor — which is
  // exactly the drift it exists to catch.
  //
  // The sweep is over the DOM (`interactiveElementsIn`), not over ARIA roles,
  // because a role sweep under-proves: an `<input type="date">` has no role at
  // all, and a `ToggleGroupItem` renders `role="radio"`, not `button`. This tab's
  // controls are all inputs and a textarea today — the DOM sweep is what keeps
  // that true for the next control someone adds to it.
  it('renders no interactive controls for a non-creator', () => {
    detailsTabPage.render({
      tournament: buildTournament(),
      canEdit: false,
    })

    expect(detailsTabPage.getFormElements()).toHaveLength(0)
    expect(detailsTabPage.getInteractiveControls()).toHaveLength(0)
  })

  it('renders no validation furniture, save state, or failure UI for a non-creator', () => {
    detailsTabPage.render({ tournament: buildTournament(), canEdit: false })

    expect(detailsTabPage.querySaveButton()).toBeNull()
    expect(detailsTabPage.querySaveError()).toBeNull()
    // No validation messages anywhere: a reader's surface has nothing to
    // validate and nothing to correct.
    expect(detailsTabPage.queryFieldMessage('Name is required.')).toBeNull()
  })

  it('renders the details as values, and addresses the reader, for a non-creator', () => {
    detailsTabPage.render({
      tournament: buildTournament({
        name: 'Bay Area Open 2026',
        status: 'published',
        description: 'Two-day open.',
      }),
      canEdit: false,
    })

    expect(
      screen.getByText('The basics for this tournament.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Players see this on the public page/),
    ).toBeNull()
    // A hint explains how to fill in a control; with no control there is
    // nothing to explain, so the read-only view drops it.
    expect(
      screen.queryByText(/Optional\. Shown on the public registration page/),
    ).toBeNull()

    // No status row, for a reader or an editor: status is not a field of this
    // form (ADR-0017) — it is the hero's badge, and it moves only through the
    // header's lifecycle button.
    expect(detailsTabPage.getReadOnlyValues()).toEqual([
      'Bay Area Open 2026',
      'Two-day open.',
      'Berkeley TT Club',
      '2727 Milvia St',
      'Berkeley',
      'CA',
      '94703',
      'USA',
    ])
    expect(detailsTabPage.querySaveButton()).toBeNull()
  })

  // A tournament may have NO VENUE at all (CONTEXT.md, "Venue") — `address: null`.
  // The edit surface must not refuse it, must not crash on it, and must not turn
  // opening the tab into an accidental venue.
  describe('a tournament with NO VENUE', () => {
    it('offers six empty venue boxes for the organizer to start one in', () => {
      detailsTabPage.render({ tournament: buildTournament({ address: null }) })

      for (const input of detailsTabPage.getVenueInputs()) {
        expect(input).toHaveValue('')
      }
      // Nothing was saved by merely looking: the blank boxes are display state, so
      // the tab is not dirty and Save is not offered.
      expect(detailsTabPage.querySaveButton()).toBeNull()
    })

    it('starts a venue from the first character typed, leaving the rest blank', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({
        tournament: buildTournament({ address: null }),
        onUpdate,
      })

      await userEvent.type(screen.getByLabelText('City'), 'Oakland')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.objectContaining({ city: 'Oakland', venue: '' }),
        }),
      )
    })

    // Clearing every box is how an organizer REMOVES a venue. The form must let
    // them: the server normalizes an all-blank address to "no venue" at its own
    // boundary, so what matters here is that nothing refuses the submit.
    it('lets the organizer clear a venue back out again', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({
        tournament: buildTournament(),
        onUpdate,
      })

      for (const input of detailsTabPage.getVenueInputs()) {
        await userEvent.clear(input)
      }
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.objectContaining({
            venue: '',
            street: '',
            city: '',
            region: '',
            postal: '',
            country: '',
          }),
        }),
      )
    })

    it('reads as six em-dashes for a non-creator — never a "TBD"', () => {
      detailsTabPage.render({
        tournament: buildTournament({
          name: 'Garage Invitational',
          description: 'Address shared with entrants.',
          address: null,
        }),
        canEdit: false,
      })

      expect(detailsTabPage.getReadOnlyValues()).toEqual([
        'Garage Invitational',
        'Address shared with entrants.',
        // The six venue rows: unset, which on a row that exists is the em-dash
        // (ADR 0015, rule 3) — the header is where the row itself disappears.
        '—',
        '—',
        '—',
        '—',
        '—',
        '—',
      ])
      expect(detailsTabPage.getFormElements()).toHaveLength(0)
    })
  })

  /**
   * The organizer meets the server's `AddressComponent` bound here, not at the
   * 422 (#1199). The bound is the zod schema's, counted in code points — the
   * boxes carry NO `maxLength`: the DOM attribute counts UTF-16 code units, so
   * it would stop a value the server accepts (128 emoji are 256 units, 128
   * code points) from ever being typed, and the schema would never see it
   * (#1593 review).
   */
  it('puts no UTF-16 typing cap on the venue boxes', () => {
    detailsTabPage.render({ tournament: buildTournament() })

    for (const input of detailsTabPage.getVenueInputs()) {
      expect(input).not.toHaveAttribute('maxlength')
    }
  })

  /** The bound is on the way IN only, exactly as on the server: a row stored
   * before it existed still has to be editable, not silently rewritten. */
  it('still shows a stored 680-character venue in full, so it can be shortened', () => {
    detailsTabPage.render({
      tournament: buildTournament({
        address: buildAddress({ venue: UNBREAKABLE_VENUE_NAME }),
      }),
    })

    const [venue] = detailsTabPage.getVenueInputs()
    expect(venue).toHaveValue(UNBREAKABLE_VENUE_NAME)
  })

  it('renders an em-dash for a field the organizer left empty', () => {
    detailsTabPage.render({
      tournament: buildTournament({ description: '' }),
      canEdit: false,
    })

    // The row is present and shows an em-dash: "the organizer set nothing" has
    // to stay distinguishable from "this does not apply".
    expect(detailsTabPage.getReadOnlyValues()).toContain('—')
  })

  /**
   * The client-side half of the save boundary (#1593). The schema mirrors every
   * constraint the server has on `TournamentUpdate` — a name the server would
   * 422 never leaves the browser — and the `maxLength` attribute is NOT the
   * guarantee: a programmatic or autofill fill sails past it, so the schema
   * refuses it at submit.
   */
  describe('client-side validation (#1593)', () => {
    it('refuses a blank name with "Name is required." and sends nothing', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.clear(detailsTabPage.getNameInput())
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(detailsTabPage.queryFieldMessage('Name is required.')).toBeInTheDocument()
      expect(detailsTabPage.getNameInput()).toBeInvalid()
      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('refuses a whitespace-only name after trimming, with the same message', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.clear(detailsTabPage.getNameInput())
      await userEvent.type(detailsTabPage.getNameInput(), '   ')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(detailsTabPage.queryFieldMessage('Name is required.')).toBeInTheDocument()
      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('refuses a name over 255 characters with a message under the box', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      fireEvent.change(detailsTabPage.getNameInput(), {
        target: { value: 'x'.repeat(256) },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(
        detailsTabPage.queryFieldMessage(
          'Name must be 255 characters or fewer.',
        ),
      ).toBeInTheDocument()
      expect(detailsTabPage.getNameInput()).toBeInvalid()
      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('accepts a name of exactly 255 characters', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      fireEvent.change(detailsTabPage.getNameInput(), {
        target: { value: 'x'.repeat(255) },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
      expect(onUpdate.mock.calls[0][0].name).toBe('x'.repeat(255))
    })

    // The server counts Unicode code points; Zod's own `.max` counts UTF-16
    // code units, under which 255 emoji are 510 "characters" — so a name the
    // server would take was refused here before the form ever sent it. The
    // schema counts code points (`atMostCodePoints`), so this name goes through.
    it('accepts a name of 255 emoji — 255 code points, 510 UTF-16 units', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      const emoji = '🏆'.repeat(255)
      // The count `.max` would have applied — the reason this test can tell
      // code points from code units at all.
      expect(emoji.length).toBe(510)

      fireEvent.change(detailsTabPage.getNameInput(), {
        target: { value: emoji },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
      expect(onUpdate.mock.calls[0][0].name).toBe(emoji)
    })

    it('refuses a name of 256 code points, emoji included', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      fireEvent.change(detailsTabPage.getNameInput(), {
        target: { value: '🏆'.repeat(256) },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(
        detailsTabPage.queryFieldMessage(
          'Name must be 255 characters or fewer.',
        ),
      ).toBeInTheDocument()
      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('refuses a description over 1,024 characters and accepts one exactly at it', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      fireEvent.change(detailsTabPage.getDescriptionInput(), {
        target: { value: 'y'.repeat(1025) },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(
        detailsTabPage.queryFieldMessage(
          'Description must be 1024 characters or fewer.',
        ),
      ).toBeInTheDocument()
      expect(onUpdate).not.toHaveBeenCalled()

      fireEvent.change(detailsTabPage.getDescriptionInput(), {
        target: { value: 'y'.repeat(1024) },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    })

    it('catches an over-long address component typed straight into the box', async () => {
      // With no `maxLength` on the boxes, the typing path itself reaches the
      // schema bound — the only statement of it left (#1593 review).
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      const postal = detailsTabPage.getVenueInputs()[4]
      fireEvent.change(postal, { target: { value: 'z'.repeat(300) } })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(
        detailsTabPage.queryFieldMessage(
          'Postal must be 255 characters or fewer.',
        ),
      ).toBeInTheDocument()
      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('accepts an address component of exactly 255 characters', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      const postal = detailsTabPage.getVenueInputs()[4]
      fireEvent.change(postal, { target: { value: 'z'.repeat(255) } })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    })

    // The UTF-16 `maxLength` this form used to carry stopped this value being
    // TYPED at all: 128 emoji are 256 UTF-16 code units — past the attribute —
    // but 128 code points, which the server accepts (#1593 review). The typing
    // path now reaches the code-point schema.
    it('accepts a venue of 128 emoji — 128 code points, 256 UTF-16 units', async () => {
      const onUpdate = vi.fn()
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      const emoji = '🏆'.repeat(128)
      expect(emoji.length).toBe(256)

      fireEvent.change(detailsTabPage.getVenueInputs()[0], {
        target: { value: emoji },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.objectContaining({ venue: emoji }),
        }),
      )
    })

    it('wires aria-invalid and aria-describedby to the rendered message', async () => {
      detailsTabPage.render({ tournament: buildTournament() })

      // A clean control describes itself by nothing — the hint id is handed out
      // only while a hint is really on screen.
      expect(detailsTabPage.getNameInput()).not.toHaveAttribute(
        'aria-describedby',
      )

      await userEvent.clear(detailsTabPage.getNameInput())
      const message = detailsTabPage.queryFieldMessage('Name is required.')
      expect(message).toBeInTheDocument()
      expect(detailsTabPage.getNameInput()).toBeInvalid()
      expect(detailsTabPage.getNameInput()).toHaveAttribute(
        'aria-describedby',
        message!.id,
      )
    })

    it('moves focus to the first invalid control when a submit is refused client-side', async () => {
      detailsTabPage.render({ tournament: buildTournament() })

      await userEvent.clear(detailsTabPage.getNameInput())
      fireEvent.change(detailsTabPage.getDescriptionInput(), {
        target: { value: 'y'.repeat(1025) },
      })
      await flush()
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(detailsTabPage.getNameInput()).toHaveFocus()
    })

    it('clears a stale field error as the field is corrected, keeping the other edits', async () => {
      detailsTabPage.render({ tournament: buildTournament() })

      fireEvent.change(detailsTabPage.getNameInput(), {
        target: { value: 'x'.repeat(256) },
      })
      await flush()
      await userEvent.type(detailsTabPage.getDescriptionInput(), ' Still on.')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      expect(
        detailsTabPage.queryFieldMessage(
          'Name must be 255 characters or fewer.',
        ),
      ).toBeInTheDocument()

      fireEvent.change(detailsTabPage.getNameInput(), {
        target: { value: 'Fixed name' },
      })
      await flush()

      expect(
        detailsTabPage.queryFieldMessage(
          'Name must be 255 characters or fewer.',
        ),
      ).toBeNull()
      // The correction did not discard the description edit.
      expect(detailsTabPage.getDescriptionInput()).toHaveValue(
        'Two-day open. USATT-sanctioned, ratings-eligible. Still on.',
      )
    })
  })

  /** The save is a promise, not a fire-and-forget: while the write is in flight
   * the Save control cannot start a second one (#1593). */
  describe('a pending save', () => {
    it('cannot submit a duplicate update while the write is pending', async () => {
      let resolve!: () => void
      const onUpdate = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolve = res
          }),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      expect(onUpdate).toHaveBeenCalledTimes(1)
      expect(detailsTabPage.querySaveButton()).toBeDisabled()

      await userEvent.click(detailsTabPage.querySaveButton()!)
      expect(onUpdate).toHaveBeenCalledTimes(1)

      resolve()
      await waitFor(() => expect(detailsTabPage.querySaveButton()).toBeEnabled())
    })

    // The finding's exact scenario (#1593 review): `form.reset` (Revert)
    // resets React Hook Form's submission state, so with the lock INSIDE the
    // form, Revert mid-flight re-opened Save and a second edit let a second
    // PATCH race the first. The lock now lives outside the form, where no
    // reset can reach it.
    it('keeps the duplicate-submit gate when Revert resets the form mid-flight', async () => {
      let resolve!: () => void
      const onUpdate = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolve = res
          }),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      expect(onUpdate).toHaveBeenCalledTimes(1)
      expect(detailsTabPage.querySaveButton()).toBeDisabled()

      // Revert hands the draft back while the write is still in flight...
      await userEvent.click(detailsTabPage.getRevertButton())
      expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026')

      // ...and a fresh edit dirties the form again — but the ORIGINAL write
      // is still pending, so Save stays shut and no second PATCH can start.
      await userEvent.type(detailsTabPage.getNameInput(), '!')
      expect(detailsTabPage.querySaveButton()).toBeDisabled()
      await userEvent.click(detailsTabPage.querySaveButton()!)
      expect(onUpdate).toHaveBeenCalledTimes(1)

      resolve()
      await waitFor(() => expect(detailsTabPage.querySaveButton()).toBeEnabled())
    })
  })

  /**
   * The server half of the save boundary (#1593). Every refusal is spoken —
   * attributed to a box where the wire names one the form shows, in the tab's
   * own alert where it cannot — every word of it ours, and the draft always
   * survives for the retry.
   */
  describe('a refused save', () => {
    it('attributes a 422 naming the name to that box, in our words — never Pydantic prose', async () => {
      const onUpdate = vi.fn().mockRejectedValue(refusedName)
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() =>
        expect(detailsTabPage.queryFieldMessage(NAME_REFUSAL)).toBeInTheDocument(),
      )
      expect(screen.queryByText(new RegExp(PYDANTIC))).toBeNull()
      // The refusal did not bin the work and did not leave silence: the draft
      // is intact, Save is still on offer, and no form-level alert competes.
      expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026!')
      expect(detailsTabPage.querySaveButton()).toBeInTheDocument()
      expect(detailsTabPage.querySaveError()).toBeNull()
    })

    it('attributes a 422 naming the description to that box', async () => {
      const onUpdate = vi.fn().mockRejectedValue(refusedDescription)
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() =>
        expect(
          detailsTabPage.queryFieldMessage(DESCRIPTION_REFUSAL),
        ).toBeInTheDocument(),
      )
      expect(screen.queryByText(new RegExp(PYDANTIC))).toBeNull()
    })

    it('moves focus to the field a 422 names, so the refusal is announced, not silent', async () => {
      const onUpdate = vi.fn().mockRejectedValue(refusedName)
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      await waitFor(() =>
        expect(detailsTabPage.queryFieldMessage(NAME_REFUSAL)).toBeInTheDocument(),
      )
      // Focus goes with the message, as it does to the form-level alert:
      // otherwise the caret stays on Save and the refused save still reads as
      // a click that did nothing.
      expect(detailsTabPage.getNameInput()).toHaveFocus()
    })

    // The boxes stay live during a slow PATCH (#1593 review): a refusal is for
    // the snapshot the attempt SENT, so a blamed box that has since changed
    // must not be reddened and have focus dragged back to it — that blames a
    // value the server never saw. The complaint goes to the alert instead.
    it('does not pin a 422 to a box whose value changed while the PATCH was pending', async () => {
      let reject!: (err: unknown) => void
      const onUpdate = vi.fn(
        () =>
          new Promise<void>((_, rej) => {
            reject = rej
          }),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      expect(onUpdate).toHaveBeenCalledTimes(1)

      // The write is slow: the organizer keeps typing, and the Name box no
      // longer holds the snapshot the server is refusing.
      await userEvent.type(detailsTabPage.getNameInput(), '?')

      await act(async () => reject(refusedName))
      await flush()

      // The refused value is gone from the box, so the complaint cannot go
      // under it — and focus must not be dragged back to it either.
      expect(detailsTabPage.queryFieldMessage(NAME_REFUSAL)).toBeNull()
      // But the refusal is still spoken: it lands on the tab's alert, which
      // takes focus the same way any other unpinnable refusal does.
      const alert = detailsTabPage.querySaveError()
      expect(alert).toBeInTheDocument()
      expect(alert).toHaveTextContent(NAME_REFUSAL)
      expect(alert).toHaveFocus()
    })

    it('sends a nested-address 422 to the form alert — never to one arbitrary box', async () => {
      // A FastAPI location under `address` identifies only the Venue address
      // block, so pinning it onto one of the six inputs would be a lie about
      // where the organizer has to look.
      const onUpdate = vi.fn().mockRejectedValue(refusedAddress)
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      const alert = await waitFor(() => {
        const el = detailsTabPage.querySaveError()
        expect(el).toBeInTheDocument()
        return el!
      })
      expect(alert).toHaveTextContent(ADDRESS_REFUSAL)
      expect(alert).toHaveTextContent(
        'Nothing was saved — your changes are still here.',
      )
      expect(screen.queryByText(new RegExp(PYDANTIC))).toBeNull()
      // Not attributed to any box.
      expect(detailsTabPage.queryFieldMessage(ADDRESS_REFUSAL)).toBeNull()
      // The draft is intact and the affordances remain for the retry.
      expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026!')
      expect(detailsTabPage.querySaveButton()).toBeInTheDocument()
    })

    it('answers a 422 naming no recognized field with the generic sentence', async () => {
      const onUpdate = vi.fn().mockRejectedValue(
        new ApiError(422, PYDANTIC, 'update tournament', {
          detail: [
            { type: 'too_big', loc: ['body', 'something_else'], msg: PYDANTIC },
          ],
        }),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      const alert = await waitFor(() => {
        const el = detailsTabPage.querySaveError()
        expect(el).toBeInTheDocument()
        return el!
      })
      expect(alert).toHaveTextContent(FIELDLESS_REFUSAL)
      expect(screen.queryByText(new RegExp(PYDANTIC))).toBeNull()
    })

    it("reports a 403 refusal in the alert, carrying the server's sentence", async () => {
      const onUpdate = vi.fn().mockRejectedValue(
        new ApiError(403, 'You can only modify tournaments you created.', 'update tournament', {
          detail: 'You can only modify tournaments you created.',
        }),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      const alert = await waitFor(() => {
        const el = detailsTabPage.querySaveError()
        expect(el).toBeInTheDocument()
        return el!
      })
      expect(alert).toHaveTextContent(
        'You can only modify tournaments you created.',
      )
      expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026!')
    })

    it('tells the truth about a 5xx — our fault, not their wifi', async () => {
      const onUpdate = vi.fn().mockRejectedValue(
        new ApiError(500, 'Internal Server Error', 'update tournament'),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      const alert = await waitFor(() => {
        const el = detailsTabPage.querySaveError()
        expect(el).toBeInTheDocument()
        return el!
      })
      expect(alert).toHaveTextContent(FAULTED_REFUSAL)
    })

    it('blames the connection only when no response ever arrived', async () => {
      const onUpdate = vi
        .fn()
        .mockRejectedValue(new TypeError('Failed to fetch'))
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      const alert = await waitFor(() => {
        const el = detailsTabPage.querySaveError()
        expect(el).toBeInTheDocument()
        return el!
      })
      expect(alert).toHaveTextContent(OFFLINE_REFUSAL)
    })

    it('answers an unclassifiable failure with "Something went wrong. Try again."', async () => {
      const onUpdate = vi.fn().mockRejectedValue(new Error('boom'))
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)

      const alert = await waitFor(() => {
        const el = detailsTabPage.querySaveError()
        expect(el).toBeInTheDocument()
        return el!
      })
      expect(alert).toHaveTextContent('Something went wrong. Try again.')
    })

    it('announces a repeated failure every time, not only on the first mount', async () => {
      const onUpdate = vi.fn().mockRejectedValue(
        new ApiError(500, 'Internal Server Error', 'update tournament'),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      await waitFor(() => expect(detailsTabPage.querySaveError()).toHaveFocus())

      // Move focus away, then fail again: the alert takes focus back, so a
      // screen reader hears the second refusal too.
      await userEvent.click(detailsTabPage.getNameInput())
      await userEvent.click(detailsTabPage.querySaveButton()!)
      await waitFor(() => expect(detailsTabPage.querySaveError()).toHaveFocus())
    })

    it('clears the failure and reconciles normally when a retry succeeds', async () => {
      const onUpdate = vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(500, 'Internal Server Error', 'update tournament'),
        )
        .mockResolvedValueOnce(undefined)
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      await waitFor(() => expect(detailsTabPage.querySaveError()).toBeInTheDocument())

      await userEvent.click(detailsTabPage.querySaveButton()!)
      await waitFor(() => expect(detailsTabPage.querySaveError()).toBeNull())
      expect(onUpdate).toHaveBeenCalledTimes(2)
    })

    it('clears the prior form-level failure when a new save attempt is refused client-side', async () => {
      const onUpdate = vi.fn().mockRejectedValue(
        new ApiError(500, 'Internal Server Error', 'update tournament'),
      )
      detailsTabPage.render({ tournament: buildTournament(), onUpdate })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      await waitFor(() => expect(detailsTabPage.querySaveError()).toBeInTheDocument())

      // The next attempt never reaches the server — the blank name is refused
      // client-side — but it is still an attempt: the stale banner goes.
      await userEvent.clear(detailsTabPage.getNameInput())
      await userEvent.click(detailsTabPage.querySaveButton()!)

      expect(detailsTabPage.querySaveError()).toBeNull()
      expect(detailsTabPage.queryFieldMessage('Name is required.')).toBeInTheDocument()
      expect(onUpdate).toHaveBeenCalledTimes(1)
    })

    it('clears a form-level refusal once the draft is back at its committed values', async () => {
      const onUpdate = vi
        .fn()
        .mockRejectedValue(
          new ApiError(500, 'Internal Server Error', 'update tournament'),
        )
      detailsTabPage.render({
        tournament: buildTournament({ name: 'Bay Area Open 2026' }),
        onUpdate,
      })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      await waitFor(() => expect(detailsTabPage.querySaveError()).toBeInTheDocument())

      // Undo the edit by hand — not with Revert — so the draft returns to the
      // committed values on its own. Save and Revert are gone; the alert must
      // not outlive them: it claims unsaved changes remain, and nothing left
      // on the tab could dismiss it.
      await userEvent.clear(detailsTabPage.getNameInput())
      await userEvent.type(detailsTabPage.getNameInput(), 'Bay Area Open 2026')
      await waitFor(() => expect(detailsTabPage.querySaveError()).toBeNull())

      expect(detailsTabPage.querySaveButton()).toBeNull()

      // Cleared, not merely hidden while pristine: a fresh edit does not
      // resurrect the stale banner.
      await userEvent.type(detailsTabPage.getNameInput(), '!')
      expect(detailsTabPage.querySaveError()).toBeNull()
    })

    it('keeps the draft — dirty and editable — after a refused save', async () => {
      const onUpdate = vi
        .fn()
        .mockRejectedValue(
          new ApiError(500, 'Internal Server Error', 'update tournament'),
        )
      detailsTabPage.render({
        tournament: buildTournament({ name: 'Bay Area Open 2026' }),
        onUpdate,
      })

      await userEvent.type(detailsTabPage.getNameInput(), '!')
      await userEvent.type(detailsTabPage.getDescriptionInput(), ' Held.')
      await userEvent.click(detailsTabPage.querySaveButton()!)
      await waitFor(() => expect(detailsTabPage.querySaveError()).toBeInTheDocument())

      // The UI never implies the rejected values committed: the edited values
      // are still in the boxes, still dirty, Save still offered for the retry,
      // and Revert can still put the committed tournament back.
      expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026!')
      expect(detailsTabPage.getDescriptionInput()).toHaveValue(
        'Two-day open. USATT-sanctioned, ratings-eligible. Held.',
      )
      expect(detailsTabPage.querySaveButton()).toBeInTheDocument()
      expect(detailsTabPage.getRevertButton()).toBeInTheDocument()

      await userEvent.click(detailsTabPage.getRevertButton())
      expect(detailsTabPage.getNameInput()).toHaveValue('Bay Area Open 2026')
      expect(detailsTabPage.querySaveButton()).toBeNull()
    })
  })
})
