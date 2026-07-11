import { render, screen, type Container } from '@/test/utilities'

import { DetailsTab, type DetailsTabProps } from './details-tab'
import { buildDetailsTabProps } from './details-tab.factory'

/** The roles a form control would take in the accessibility tree. Kept only as
 * a supplement: the role sweep alone *under-proves*, because a `type="number"`
 * input is a `spinbutton`, a `type="date"` input has no role at all, and a
 * `ToggleGroupItem` is a `radio` rather than a `button`. */
const INTERACTIVE_ROLES = [
  'textbox',
  'combobox',
  'switch',
  'button',
  'radio',
  'spinbutton',
] as const

/** Every interactive element, by tag rather than by role — the sweep that
 * actually holds the line (ADR 0015, `web-client/CLAUDE.md`). It catches the
 * element whatever role it claims, including the roleless ones. */
const FORM_ELEMENTS =
  'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]'

const scoped = (container: Container) => ({
  getNameInput() {
    return container.getByLabelText(/Name/)
  },
  /** The "Name" field's label row, as `textContent` — which is where the
   * required asterisk actually shows up ("Name*"). It cannot be asserted through
   * the *query*: `getByText` matches a node's direct text children only, and the
   * asterisk is a nested `<span>`, so "Name" finds the label whether or not it is
   * marked required. Exact, or this would also match the "Venue name" row. */
  getNameLabelText() {
    return container.getByText('Name', { exact: true, selector: 'label' })
      .textContent
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
  getRevertButton() {
    return container.getByRole('button', { name: /Revert/ })
  },
  /** The read-only rendering of the fields, in document order — what a
   * non-creator sees where the creator gets controls (ADR 0015). */
  getReadOnlyValues() {
    const values: HTMLElement[] = container.queryAllByTestId(
      'tournament-read-only-value',
    )
    return values.map((el) => el.textContent)
  },
  /** Every interactive control in the tab, swept by role. Supplement only —
   * assert on `getFormElements()` for the guarantee. */
  getInteractiveControls() {
    return INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
  },
  /** Every form element in the tab, by tag. Empty is the whole point of the
   * read-only view. */
  getFormElements() {
    const root: HTMLElement = container.getByTestId('details-tab')
    return root.querySelectorAll(FORM_ELEMENTS)
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
