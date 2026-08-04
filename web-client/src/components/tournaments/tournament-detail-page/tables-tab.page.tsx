import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { TablesTab, type TablesTabProps } from './tables-tab'
import { buildTablesTabProps } from './tables-tab.factory'

const scoped = (container: Container) => ({
  getRemoveButton(label: string) {
    return container.getByRole('button', { name: `Remove ${label}` })
  },
  /** A table's Remove button — absent for a non-creator (`canEdit: false`). */
  queryRemoveButton(label: string) {
    return container.queryByRole('button', { name: `Remove ${label}` })
  },
  getLabelInput() {
    return container.getByRole('textbox', { name: 'Table label' })
  },
  getCourtInput() {
    return container.getByRole('textbox', { name: 'Court' })
  },
  /** The Court field's placeholder — must hint a BARE value (e.g. "A"), never
   * "Court", or a user following it types "Court A" → card "Court Court A". */
  getCourtPlaceholder() {
    return this.getCourtInput().getAttribute('placeholder')
  },
  getAddButton() {
    return container.getByRole('button', { name: 'Add table' })
  },
  /** The in-use refusal's confirm — the 409 asked back as a question (ADR 20260801).
   * Queried off `screen`, never the tab's container: an `AlertDialog` is PORTALED to
   * the body, so a container-scoped query finds nothing whether it opened or not. */
  queryConfirmDialog() {
    return screen.queryByTestId('confirm-remove-table')
  },
  /** The confirm's body — the SERVER's sentence, verbatim. The assertion the whole
   * dialog exists for: it names the tables and the match count, which the client
   * cannot reconstruct. */
  getConfirmDetail() {
    return screen.getByTestId('confirm-remove-table-detail')
  },
  getConfirmRemoveButton() {
    return screen.getByTestId('confirm-remove-table-confirm')
  },
  getConfirmCancelButton() {
    return screen.getByTestId('confirm-remove-table-cancel')
  },
  /** The inline failure banner for remove/confirm — every failure that is NOT the
   * in-use refusal, in the client's own words (`saveFailureMessage`). Absent when
   * the last write landed. Remove/confirm are button-triggered actions, not a form
   * with a field to blame, so they keep this page-level banner rather than routing
   * through `addTableForm`. */
  queryError() {
    return container.queryByTestId('tables-error')
  },
  /** The add-table form's own root-level error — `addTableForm.formState.errors.root`,
   * rendered beside the field it belongs to rather than the shared page-level banner
   * above. `label`/`court` carry no server-mirrored constraint to pin a 422 to
   * (both are bare, unconstrained `str`), so every submit failure lands here. */
  queryAddTableError() {
    return container.queryByTestId('add-table-error')
  },
  /** The label field's own inline validation message — RHF+Zod's client-side
   * "Label is required.", never sent to the server. */
  queryLabelError() {
    return container.queryByText('Label is required.')
  },
  /** The add-table submit button — absent for a non-creator (`canEdit: false`),
   * along with the rest of the add-table form. */
  queryAddButton() {
    return container.queryByRole('button', { name: 'Add table' })
  },
  /** EVERY interactive control in the tab, swept over the DOM (ADR-0015 rule 6) —
   * the guard a "a non-owner is offered nothing to mutate" claim needs. A role sweep
   * would under-prove: the add-table form's inputs are role-queryable, but the rule
   * is *no control at all*, and the sweep is the one that holds that line. */
  getControls() {
    return interactiveElementsIn(container.getByTestId('tables-tab'))
  },
})

/** Test page-object for `TablesTab`. */
export const tablesTabPage = {
  render(overrides: Partial<TablesTabProps> = {}) {
    render(<TablesTab {...buildTablesTabProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
