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
  // The sweep is over the DOM, not over ARIA roles: the tab's status control is
  // a `ToggleGroup`, whose items are `radio`s rather than `button`s, so a
  // role-only sweep of textbox/combobox/switch/button would go green with the
  // whole toggle group still live. Assert on the elements themselves.
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

    expect(detailsTabPage.getReadOnlyValues()).toEqual([
      'Bay Area Open 2026',
      'Two-day open.',
      'Published',
      'Berkeley TT Club',
      '2727 Milvia St',
      'Berkeley',
      'CA',
      '94703',
      'USA',
    ])
    expect(detailsTabPage.querySaveButton()).toBeNull()
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
