import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { fieldPage } from '../../field.page'
import { BasicsSection, type BasicsSectionProps } from './basics-section'
import { buildBasicsSectionProps } from './basics-section.factory'

const scoped = (container: Container) => ({
  /** Reuse the `Field` row queries (label text, the read-only value under a
   * label) — this section is nothing but `Field` rows. */
  ...fieldPage.within(container),

  getNameInput() {
    return container.getByLabelText(/Event name/)
  },
  getPlayerLimitInput() {
    return container.getByLabelText(/Player limit/)
  },
  getEntryFeeInput() {
    return container.getByLabelText(/Entry fee/)
  },
  /** The red message under a field — the `Field` row's `hint`, rendered as an error.
   * Queried by its TEXT because that is what the organizer reads; a test that asked
   * for "the hint node" would pass on a message rendered in the wrong colour under
   * the wrong control. */
  queryFieldError(message: string | RegExp) {
    return container.queryByText(message)
  },
  getFormatTrigger() {
    return container.getByRole('combobox', { name: 'Format' })
  },
  /** The searchable IANA timezone picker's trigger (ADR 20260719). A combobox, like
   * the format/draw-type selects — but backed by `Popover` + `Command`, not `Select`. */
  getTimezoneTrigger() {
    return container.getByRole('combobox', { name: 'Timezone' })
  },
  /** The timezone caption beside the Time slot — the frame the wall-clock window is
   * in, shown to editor and reader alike (`event-timezone-label`). */
  getTimezoneLabel() {
    return container.getByTestId('event-timezone-label')
  },
  /** The draw-type select. Present-but-**disabled** once the event's draw is cut
   * (ADR-0786) — so it is queried by role, not by "an enabled combobox": the state
   * under test is a control that is there, readable, and dead. */
  getDrawTypeTrigger() {
    return container.getByRole('combobox', { name: 'Draw type' })
  },
  /** The player-limit helper text — form furniture, and so absent from the
   * read-only view (ADR 0015). It is also the one place the editor says out loud
   * that leaving the box empty is *allowed* (ADR-0935). */
  queryPlayerLimitHint() {
    return container.queryByText(/Blank = no cap\. Waitlist opens past this\./)
  },
  /** Every interactive control in the section, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the section, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('basics-section'))
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
