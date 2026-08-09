import userEvent from '@testing-library/user-event'

import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

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
  /** **K** — kept as a `query` and nothing else, because the only claim this tab has left
   * to make about the qualifier count is that it is **not here** (chore 3e). It moved to
   * the Draw structure tab, and a box that came back would be a second control writing one
   * field: the two would disagree the moment either changed.
   *
   * Asked by LABEL, and by the WHOLE row rather than by `getFormElements().length`, so it
   * discriminates "the qualifier count is gone" from "some other row went missing too".
   * There is deliberately no `get` twin: no test on this tab should be able to demand it. */
  queryQualifiersControl() {
    return container.queryByLabelText(/Qualifiers per pool/)
  },
  /** …and the same claim one level out, which is the one a READER needs: a read-only row
   * has no control to query for, only a label and a value (ADR 0015), so "the control is
   * gone" would pass on a row that is still there in text. The LABEL is what both branches
   * of the row share. */
  queryQualifiersRow() {
    return container.queryByText('Qualifiers per pool', { selector: 'label' })
  },
  /** **R** — the round-count box, which exists only for a `swiss` event (the swiss ADR).
   * `get` for the case that expects it. */
  getRoundsInput() {
    return container.getByLabelText(/^Rounds/)
  },
  /** …and the `query` twin, because "this control is NOT on screen" is the claim for
   * every other draw type: a round count is not a blank field a round-robin event has,
   * it is a question that format does not ask. Asked by LABEL rather than by
   * `getFormElements().length`, so it discriminates "the row is absent" from "some other
   * row went missing too". */
  queryRoundsInput() {
    return container.queryByLabelText(/^Rounds/)
  },
  /** The round count as a **reader** sees it — the `Field` read-only branch's value under
   * its label (ADR 0015). Use `queryRoundsInput` for the "row absent" claim. */
  getRoundsValue() {
    return fieldPage.within(container).getFieldValue('Rounds')
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
  /** Open the draw-type picker and read back **what it actually offers**, in order —
   * the labels a director sees, which since ADR 20260726 are the server's own
   * (`draw_type_catalogue`) rather than a list this client keeps.
   *
   * The radix listbox portals to the body, so the options resolve against `screen`,
   * not the scoped container. */
  async openDrawTypeOptions() {
    await userEvent.click(this.getDrawTypeTrigger())
    const listbox = await screen.findByRole('listbox')
    return within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent?.trim() ?? '')
  },
  /** Open the draw-type picker and choose the option labelled `label`. */
  async chooseDrawType(label: string) {
    await userEvent.click(this.getDrawTypeTrigger())
    await userEvent.click(await screen.findByRole('option', { name: label }))
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
  /** Mount the section. Returns the render result, plus `rerenderWith` — which is the
   * only honest way to assert that a row **disappears**.
   *
   * ⚠️ Calling `render` a second time does NOT replace the first tree: Testing Library
   * appends a second one, and `screen` spans the whole body, so a "the control is gone"
   * assertion would find the *previous* mount's control and fail against a component that
   * unmounts perfectly well (measured: two renders → 2 `basics-section` roots; a
   * `rerenderWith` → 1 root and the control really gone). Prop-change claims use this. */
  render(overrides: Partial<BasicsSectionProps> = {}) {
    const utils = render(<BasicsSection {...buildBasicsSectionProps(overrides)} />)
    return {
      ...utils,
      rerenderWith(next: Partial<BasicsSectionProps> = {}) {
        utils.rerender(<BasicsSection {...buildBasicsSectionProps(next)} />)
      },
    }
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
