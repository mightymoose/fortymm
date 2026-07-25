import userEvent from '@testing-library/user-event'

import { buildTable, buildTables } from '../data/seed.factory'
import { tablesTabPage } from './tables-tab.page'

describe('TablesTab', () => {
  it('adds a new table to the catalogue', async () => {
    const onChangeCatalogue = vi.fn()
    tablesTabPage.render({
      catalogue: buildTables(2),
      onChangeCatalogue,
    })

    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    await userEvent.type(tablesTabPage.getCourtInput(), '9')
    await userEvent.click(tablesTabPage.getAddButton())

    expect(onChangeCatalogue).toHaveBeenCalledTimes(1)
    const next = onChangeCatalogue.mock.calls[0][0]
    expect(next).toHaveLength(3)
    expect(next[2]).toEqual(
      expect.objectContaining({ label: 'T9', court: '9' }),
    )
  })

  // The Court field is already labeled "Court" (its aria-label), and the card
  // renders "Court {court}" — so the value stored is a BARE identifier. The
  // placeholder must hint that bare value, never "Court", or a user who follows
  // it types "Court A" and the card reads "Court Court A".
  it('hints a bare Court value, not "Court", so "Court Court A" is impossible', async () => {
    const onChangeCatalogue = vi.fn()
    tablesTabPage.render({
      catalogue: buildTables(2),
      onChangeCatalogue,
    })

    const placeholder = tablesTabPage.getCourtPlaceholder()
    expect(placeholder).not.toBe('Court')
    expect(placeholder).not.toMatch(/court/i)

    // A user following the placeholder types just "A".
    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    await userEvent.type(tablesTabPage.getCourtInput(), 'A')
    await userEvent.click(tablesTabPage.getAddButton())

    const next = onChangeCatalogue.mock.calls[0][0]
    // Stored raw as "A" (not "Court A") → the card's "Court " prefix reads "Court A".
    expect(next[2]).toEqual(expect.objectContaining({ label: 'T9', court: 'A' }))
  })

  // The card prepends "Court " to the raw value, so a bare "A" reads "Court A"
  // (and never the "Court Court A" a "Court"-nudged value would produce).
  it('renders a bare court value as "Court A" on the card', () => {
    tablesTabPage.render({
      catalogue: [buildTable({ id: 't1', label: 'T1', court: 'A' })],
    })

    expect(document.body).toHaveTextContent('Court A')
    expect(document.body).not.toHaveTextContent('Court Court A')
  })

  it('keeps the add button disabled until a label is entered', async () => {
    tablesTabPage.render({ catalogue: buildTables(2) })

    expect(tablesTabPage.getAddButton()).toBeDisabled()
    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    expect(tablesTabPage.getAddButton()).toBeEnabled()
  })

  it('removes a table from the catalogue', async () => {
    const onChangeCatalogue = vi.fn()
    tablesTabPage.render({
      catalogue: buildTables(3),
      onChangeCatalogue,
    })

    await userEvent.click(tablesTabPage.getRemoveButton('T1'))

    expect(onChangeCatalogue).toHaveBeenCalledWith([
      expect.objectContaining({ id: 't2' }),
      expect.objectContaining({ id: 't3' }),
    ])
  })

  it('hides the add-table form and per-row removes for a non-creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: false })

    expect(tablesTabPage.queryAddButton()).toBeNull()
    expect(tablesTabPage.queryRemoveButton('T1')).toBeNull()
    // The table list itself stays visible (read-only).
    expect(document.body).toHaveTextContent('T1')
  })

  // ADR-0015 rule 6: a non-owner gets a rendering, never controls — and the DOM
  // sweep (not a role query) is the discriminating guard. The catalogue's whole
  // editor — the add-table inputs and every per-row Remove — is gone, not disabled.
  it('renders no interactive controls for a non-creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: false })

    expect(tablesTabPage.getControls()).toHaveLength(0)
  })

  // The other half, so the guard above cannot be satisfied by deleting the form for
  // everyone: the creator still gets the full catalogue editor.
  it('gives the creator the catalogue editor', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: true })

    expect(tablesTabPage.getControls().length).toBeGreaterThan(0)
  })

  // The subtitle's second sentence is an instruction only the organizer can
  // follow (ADR 0015, rule 5: copy addresses the reader). Both halves of this
  // pair matter: dropping the sentence for *everyone* would satisfy the
  // non-creator assertion alone.
  it('keeps the organizer-voiced subtitle for the creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: true })

    expect(document.body).toHaveTextContent(
      'The physical tables available at this venue. Add them to pools when configuring events.',
    )
  })

  it('drops the organizer-voiced subtitle for a non-creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: false })

    expect(document.body).toHaveTextContent(
      'The physical tables available at this venue.',
    )
    expect(document.body).not.toHaveTextContent('Add them to pools')
  })
})
