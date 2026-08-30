import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { fieldPage } from '../field.page'
import { READ_ONLY_VALUE_TESTID } from '../read-only-value.page'
import { DetailsTab, type DetailsTabProps } from './details-tab'
import { buildDetailsTabProps } from './details-tab.factory'

const scoped = (container: Container) => ({
  /** Reuse the `Field` row queries — the tab is a grid of `Field` rows. */
  ...fieldPage.within(container),

  getNameInput() {
    return container.getByLabelText(/Name/)
  },
  getDescriptionInput() {
    return container.getByLabelText('Description')
  },
  /** A field-level validation message — the red `<p>` under the control, by its
   * exact sentence, whether it came from the Zod schema or from a server refusal
   * the form attributed to that box. Absent when the field is clean. */
  queryFieldMessage(text: string) {
    return container.queryByText(text)
  },
  /** The form-level save-failure alert — every refused write the form cannot pin
   * to one box (a nested-address 422, another 4xx, a 5xx, an outage, a bug), in
   * the client's own words. Absent while the last attempt did not fail. */
  querySaveError() {
    return container.queryByTestId('details-save-error')
  },
  /** The six venue boxes, in the order the Venue & address card lays them out.
   * A tournament with NO VENUE (`address: null`) still gets all six — empty — so
   * the organizer has somewhere to type one. */
  getVenueInputs() {
    return ['Venue name', 'Street', 'City', 'Region', 'Postal', 'Country'].map(
      (label) => container.getByLabelText(label, { exact: true }),
    )
  },
  /** The "Name" field's label row, as `textContent` — which is where the
   * required asterisk actually shows up ("Name*"). It cannot be asserted through
   * the *query*: `getByText` matches a node's direct text children only, and the
   * asterisk is a nested `<span>`, so "Name" finds the label whether or not it is
   * marked required. Exact, or this would also match the "Venue name" row. */
  getNameLabelText() {
    return fieldPage.within(container).getLabelText('Name', { exact: true })
  },
  /** The Description hint — form furniture, so absent for a viewer (ADR 0015). */
  queryDescriptionHint() {
    return container.queryByText(
      /Optional\. Shown on the public registration page\./,
    )
  },
  querySaveButton() {
    return container.queryByRole('button', { name: /Save changes/ })
  },
  /** The Status row, which no longer exists in either branch: status is not a
   * field of this form (ADR-0017). Matches the label whether it were rendered as
   * a control or as a read-only value. */
  queryStatusField() {
    return container.queryByText('Status')
  },
  /** Every `radio` in the tab — what a `ToggleGroupItem` renders as (NOT a
   * `button`). The status toggle was the only one; this is what proves it gone. */
  queryAllRadios() {
    return container.queryAllByRole('radio')
  },
  getRevertButton() {
    return container.getByRole('button', { name: /Revert/ })
  },
  /** The read-only rendering of the fields, in document order — what a
   * non-creator sees where the creator gets controls (ADR 0015). */
  getReadOnlyValues() {
    const values: HTMLElement[] =
      container.queryAllByTestId(READ_ONLY_VALUE_TESTID)
    return values.map((el) => el.textContent)
  },
  /** Every interactive control in the tab, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the tab, swept by DOM (`@/test/read-only`).
   * Empty is the whole point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('details-tab'))
  },
})

/** Test page-object for `DetailsTab`. */
export const detailsTabPage = {
  render(overrides: Partial<DetailsTabProps> = {}) {
    render(<DetailsTab {...buildDetailsTabProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
