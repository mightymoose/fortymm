import userEvent from '@testing-library/user-event'

import { screen } from '@/test/utilities'

import { buildTournament } from '../data/seed.factory'
import { detailsTabPage } from './details-tab.page'

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
      screen.queryByText(/Optional. Shown on the public registration page/),
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

  it('renders an em-dash for a field the organizer left empty', () => {
    detailsTabPage.render({
      tournament: buildTournament({ description: '' }),
      canEdit: false,
    })

    // The row is present and shows an em-dash: "the organizer set nothing" has
    // to stay distinguishable from "this does not apply".
    expect(detailsTabPage.getReadOnlyValues()).toContain('—')
  })
})
