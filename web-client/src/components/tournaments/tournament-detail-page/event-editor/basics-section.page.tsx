import { render, screen, within, type Container } from '@/test/utilities'

import { BasicsSection, type BasicsSectionProps } from './basics-section'
import { buildBasicsSectionProps } from './basics-section.factory'

/** The roles a form control would take in the accessibility tree. A read-only
 * surface must render none of them (ADR 0015). */
const INTERACTIVE_ROLES = ['textbox', 'combobox', 'switch', 'button'] as const

/** The role sweep alone under-proves this section: a `type="number"` input is a
 * `spinbutton` and a `type="date"`/`type="time"` input has no role at all, so a
 * forgotten numeric or date field would slip through it. This catches the
 * element itself, whatever role it claims.
 *
 * The full selector documented in `web-client/CLAUDE.md`, verbatim: a shortened
 * one is a sweep with a hole in it — a `ToggleGroupItem` (`[role="radio"]`) or a
 * hand-rolled focusable `[tabindex]` div would walk straight through. */
const FORM_ELEMENTS =
  'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]'

const scoped = (container: Container) => ({
  getNameInput() {
    return container.getByLabelText(/Event name/)
  },
  getPlayerLimitInput() {
    return container.getByLabelText(/Player limit/)
  },
  getFormatTrigger() {
    return container.getByRole('combobox', { name: 'Format' })
  },
  /** The read-only value rendered in place of a field's control, found by the
   * field's label so the assertion survives a re-ordering of the rows. */
  getFieldValue(label: string) {
    const row = container
      .getByText(label, { exact: false, selector: 'label' })
      .closest('div')!
    return within(row).getByTestId('tournament-read-only-value')
  },
  /** A field's label row as text. The required asterisk is a `<span>` inside the
   * `<label>` with no separating space ("Event name*"), so it shows up only in
   * the label's `textContent` — never as a text node you could query for. */
  getLabelText(label: string) {
    return container.getByText(label, { exact: false, selector: 'label' })
      .textContent
  },
  /** The "Hard cap…" helper text under Player limit — form furniture, and so
   * absent from the read-only view (ADR 0015). */
  queryPlayerLimitHint() {
    return container.queryByText(/Hard cap\. Waitlist opens past this\./)
  },
  /** Every interactive control in the section. Empty is the point of the
   * read-only view. */
  getInteractiveControls() {
    return INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
  },
  /** Every form element in the section, by tag rather than by role — the
   * escape hatch the role sweep misses. */
  getFormElements() {
    return container
      .getByTestId('basics-section')
      .querySelectorAll(FORM_ELEMENTS)
  },
})

/** Test page-object for `BasicsSection`. */
export const basicsSectionPage = {
  render(overrides: Partial<BasicsSectionProps> = {}) {
    render(<BasicsSection {...buildBasicsSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
