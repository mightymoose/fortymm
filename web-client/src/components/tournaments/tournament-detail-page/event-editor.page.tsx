import userEvent from '@testing-library/user-event'

import { render, screen, type Container } from '@/test/utilities'

import { confirmIrreversibleActDialogPage } from './confirm-irreversible-act-dialog.page'
import { EventEditor, type EventEditorProps } from './event-editor'
import { buildEventEditorProps } from './event-editor.factory'
import { drawStructureSectionPage } from './event-editor/draw-structure-section.page'

const scoped = (container: Container) => ({
  getSectionTab(label: string) {
    return container.getByRole('tab', { name: label })
  },
  /** …and its `query` twin, for the claim that a tab is **not on the list at all** —
   * the Draw structure tab exists only for `rr-then-ko` (ADR 20260808). */
  querySectionTab(label: string) {
    return container.queryByRole('tab', { name: label })
  },
  /** Every tab's label, in the order the list renders them. */
  getSectionTabLabels(): string[] {
    return container
      .queryAllByRole('tab')
      .map((tab: HTMLElement) => (tab.textContent ?? '').trim())
  },
  /** The Draw structure tab's panel, and the queries inside it. Reused from the
   * section's own page object, scoped to the editor. */
  drawStructure: drawStructureSectionPage.within(container),
  /** The confirm the editor itself opens — today the one a **draw-type change** buys, when
   * the director owns a structural setting the switch would discard (ADR 20260808).
   *
   * At SCREEN scope on purpose, exactly as the section's own `confirm` is: an `AlertDialog`
   * portals to the body, so a container-scoped query would find nothing and pass while
   * checking nothing. There is only ever one `alertdialog` on screen, so this and
   * `drawStructure.confirm` reach the same node — they are named apart because the acts
   * they price are. */
  confirm: confirmIrreversibleActDialogPage,
  /** The sheet itself — present exactly while the editor is open. The claim
   * "a refused save does not close the editor" is a claim about this node. */
  querySheet() {
    return container.queryByRole('dialog')
  },
  /** The event's name control (Basics), so a test can prove the organizer's typing
   * SURVIVED a refused save rather than merely that the sheet is still there. */
  getNameInput() {
    return container.getByLabelText(/Event name/)
  },
  getPlayerLimitInput() {
    return container.getByLabelText(/Player limit/)
  },
  /** A pool's name box (Table pools). Singular: the seeded event has one pool, and a
   * test that wants two says so and reads them off `getPoolNameInputs()`. */
  getPoolNameInput() {
    return container.getByLabelText('Pool name')
  },
  getPoolNameInputs() {
    return container.queryAllByLabelText('Pool name')
  },
  /** The red messages under the pool name boxes, in card order — the Table pools
   * counterpart of `queryFieldError` on Basics and `getRuleErrors()` on Eligibility. */
  getPoolNameErrors(): (string | null)[] {
    return container
      .queryAllByTestId('pool-name-error')
      .map((node: HTMLElement) => node.textContent)
  },
  /** A red message under a Basics field (the `Field` row's error `hint`) — the
   * counterpart of `getRuleErrors()` on the other tab. Queried by the text the
   * organizer reads. */
  queryFieldError(message: string) {
    return container.queryByText(message)
  },
  /** The editor's report of a refused save — the `Alert` that keeps the failure
   * next to the unsaved work, instead of a toast that leaves in four seconds. */
  queryFailure() {
    return container.queryByTestId('event-editor-error')
  },
  /** The red messages under the rule rows (`predicate-error`), scoped to the whole
   * editor — the Eligibility tab is where a refused-in-the-form save lands. */
  getRuleErrors() {
    return container.queryAllByTestId('predicate-error')
  },
  getRuleErrorMessages(): (string | null)[] {
    return container
      .queryAllByTestId('predicate-error')
      .map((node: HTMLElement) => node.textContent)
  },
  getOperatorSelect() {
    return container.getByRole('combobox', { name: 'Operator' })
  },
  getValueInput() {
    return container.getByLabelText('Value')
  },
  getAddRuleButton() {
    return container.getByRole('button', { name: /Add (a )?rule/ })
  },
  /** The header overline above the event's name: "New event" / "Edit event" for
   * the creator, plain "Event" for a viewer. Read by test-id rather than by text
   * — "Event" is a substring of both editor labels *and* of the event names in
   * the title beneath it, so a text query would match the wrong node. */
  getOverline() {
    return container.getByTestId('event-editor-overline')
  },
  getSaveButton() {
    return container.getByRole('button', { name: /Create event|Save changes/ })
  },
  getEntryFeeInput() {
    return container.getByLabelText(/Entry fee/)
  },
  /** **K** — the qualifier count's box, on the **Draw structure** tab since chore 3e.
   *
   * It is reached through `drawStructure.setting('Qualifiers per pool')` like every other
   * setting on that tab; what is left here is the editor-scoped `query`, for the one claim
   * this level makes — that no box for K is on screen.
   *
   * ⚠️ It proves *absence only where a box could be*. Radix unmounts an inactive tab's
   * panel, so this is null for a two-stage event standing on Basics too — which is exactly
   * what makes it the right query for "Basics does not render one", and the wrong one for
   * "the tab is gone". Pair it with `querySectionTab('Draw structure')` for that. */
  queryQualifiersInput() {
    return container.queryByLabelText(/Qualifiers per pool/)
  },
  /** The draw-type select on Basics. */
  getDrawTypeTrigger() {
    return container.getByRole('combobox', { name: 'Draw type' })
  },
  /** Pick a draw type the way a director does — open the select, click the option by the
   * label the SERVER sent (ADR 20260726). The radix listbox portals to the body, so the
   * option resolves against `screen` rather than the scoped container. */
  async chooseDrawType(label: string) {
    await userEvent.click(this.getDrawTypeTrigger())
    await userEvent.click(await screen.findByRole('option', { name: label }))
  },
  /** An inline validation/server error rendered below a Basics field — the same
   * node `queryFieldError` returns, taking a `RegExp` for the cases that only want
   * to pin a phrase. */
  queryError(message: string | RegExp) {
    return container.queryByText(message)
  },
  /** The save/create action — absent for a non-creator (`canEdit: false`),
   * who gets a read-only view. */
  querySaveButton() {
    return container.queryByRole('button', { name: /Create event|Save changes/ })
  },
  getCancelButton() {
    return container.getByRole('button', { name: 'Cancel' })
  },
  /** The footer dismiss button: "Cancel" when editable, "Done" when read-only. */
  getDismissButton() {
    return container.getByRole('button', { name: /Cancel|Done/ })
  },
  queryDeleteButton() {
    return container.queryByRole('button', { name: 'Delete event' })
  },
})

/**
 * Test page-object for `EventEditor`. The sheet portals to the body, so
 * accessors run against `screen`.
 */
export const eventEditorPage = {
  render(overrides: Partial<EventEditorProps> = {}) {
    const view = render(<EventEditor {...buildEventEditorProps(overrides)} />)
    return {
      ...view,
      /** Hand the **same mounted editor** a new set of props — how a director opens it on
       * another event, and the only way to say that: a second `render` mounts a second
       * editor, so state the first one was holding is still there, in a component the
       * assertions can no longer tell apart from the new one. */
      rerenderWith(next: Partial<EventEditorProps> = {}) {
        view.rerender(<EventEditor {...buildEventEditorProps(next)} />)
      },
    }
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
