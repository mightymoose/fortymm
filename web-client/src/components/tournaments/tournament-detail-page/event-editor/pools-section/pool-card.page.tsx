import { render, screen, within, type Container } from '@/test/utilities'

import { PoolCard, type PoolCardProps } from './pool-card'
import { buildPoolCardProps } from './pool-card.factory'

/** The roles a form control would take in the accessibility tree. A read-only
 * card must render none of them (ADR 0015). */
const INTERACTIVE_ROLES = ['textbox', 'combobox', 'switch', 'button'] as const

/** The role sweep alone under-proves this card: its window is three
 * `type="date"` / `type="time"` inputs, which have **no ARIA role at all** — a
 * whole live date/time row sails straight through a role sweep. This catches the
 * element itself, whatever role it claims (ADR 0015, rule 6). */
const FORM_ELEMENTS =
  'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]'

const scoped = (container: Container) => ({
  getCard() {
    return container.getByTestId('pool-card')
  },
  getNameInput() {
    return container.getByLabelText('Pool name')
  },
  queryNameInput() {
    return container.queryByLabelText('Pool name')
  },
  getTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: false })
  },
  getSelectedTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: true })
  },
  getRemoveButton() {
    return container.getByRole('button', { name: 'Remove pool' })
  },
  /** Absent for a viewer: a mutating affordance is hidden, never disabled. */
  queryRemoveButton() {
    return container.queryByRole('button', { name: 'Remove pool' })
  },
  /** The pool's name, read back as text (the read-only counterpart of the name
   * box). */
  getName() {
    return container.getByTestId('pool-name')
  },
  /** The tables this pool reserves, read back as a list. */
  getReservedTables() {
    return container.getByTestId('pool-tables')
  },
  /** The read-only value rendered in place of a window field's control, found by
   * the field's label so the assertion survives a re-ordering of the row. */
  getFieldValue(label: string) {
    const row = container
      .getByText(label, { exact: false, selector: 'label' })
      .closest('div')!
    return within(row).getByTestId('tournament-read-only-value')
  },
  /** Every interactive control in the card. Empty is the point of the read-only
   * view. */
  getInteractiveControls() {
    return INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
  },
  /** Every form element in the card, by tag/widget role rather than by the four
   * canonical roles — the escape hatch the role sweep misses. */
  getFormElements() {
    return container.getByTestId('pool-card').querySelectorAll(FORM_ELEMENTS)
  },
})

/** Test page-object for `PoolCard`. */
export const poolCardPage = {
  render(overrides: Partial<PoolCardProps> = {}) {
    render(<PoolCard {...buildPoolCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
