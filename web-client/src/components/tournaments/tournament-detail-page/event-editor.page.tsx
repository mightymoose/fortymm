import userEvent from '@testing-library/user-event'

import { renderWithRouterContext } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

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
  /** A reservation's name box (Reservations). Singular: the seeded event has one
   * reservation, and a test that wants two says so and reads them off
   * `getReservationNameInputs()`. */
  getReservationNameInput() {
    return container.getByLabelText('Reservation name')
  },
  getReservationNameInputs() {
    return container.queryAllByLabelText('Reservation name')
  },
  /** The Reservations tab's Add button (`getAddReservationButton` matches either the
   * header's "Add reservation" or the empty state's "Add first reservation" — #1482's
   * cap disables whichever renders). */
  getAddReservationButton() {
    return container.getByRole('button', { name: /Add (first )?reservation/ })
  },
  getRemoveReservationButtons() {
    return container.queryAllByRole('button', { name: 'Remove reservation' })
  },
  /** #1482's cap notice on the Reservations tab — why Add is disabled. */
  queryReservationsCapNotice() {
    return container.queryByTestId('reservations-cap-notice')
  },
  /** #1482's array-level save refusal — a non-`rr-then-ko` event that would be left
   * holding more than one reservation. The client's OWN sentence (`event-form.ts`'s
   * `reservationCapMessage`), never the server's. */
  queryReservationsCapError() {
    return container.queryByTestId('reservations-cap-error')
  },
  /** The red messages under the reservation name boxes, in card order — the
   * Reservations counterpart of `queryFieldError` on Basics and `getRuleErrors()` on
   * Eligibility. */
  getReservationNameErrors(): (string | null)[] {
    return container
      .queryAllByTestId('reservation-name-error')
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
  /** The conflict banner's deliberate override (#1499) — present only for a
   * `conflict` failure with a live `currentLockVersion` to re-send against. */
  queryOverrideButton() {
    return container.queryByTestId('event-editor-override')
  },
  getOverrideButton() {
    return container.getByTestId('event-editor-override')
  },
  /** The conflict banner's other branch: the event was deleted elsewhere, so
   * there is nothing left to overwrite and no override button renders at all. */
  queryConflictDeletedNotice() {
    return container.queryByTestId('event-editor-conflict-deleted')
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
  /** **K** — the qualifier-count box on Basics, which exists only while the draft's draw
   * type is `rr-then-ko` (ADR 20260727). */
  getQualifiersInput() {
    return container.getByLabelText(/Qualifiers per group/)
  },
  /** …and its `query` twin, for the claim that the row is not on screen at all for a
   * draw type with no knockout stage. */
  queryQualifiersInput() {
    return container.queryByLabelText(/Qualifiers per group/)
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
  /** The #1537 newly-stranded-match confirmation — portals to the body like every
   * other `AlertDialog` here, so these resolve fine against a scoped container too
   * (`within` always falls through to `screen` for a portal in practice). */
  queryStrandConfirm() {
    return container.queryByTestId('strand-confirm-dialog')
  },
  getStrandConfirm() {
    return container.getByTestId('strand-confirm-dialog')
  },
  getStrandConfirmSave() {
    return container.getByTestId('strand-confirm-save')
  },
  getStrandConfirmCancel() {
    return container.getByTestId('strand-confirm-cancel')
  },
})

/**
 * Test page-object for `EventEditor`. The sheet portals to the body, so
 * accessors run against `screen`.
 */
export const eventEditorPage = {
  /** The editor holds the discard guard (`useBlocker`, #1503), so it needs a router
   * in context. `renderWithRouterContext` supplies one and still renders
   * synchronously, which is why every assertion in this suite is still a `getBy…`. */
  render(overrides: Partial<EventEditorProps> = {}) {
    renderWithRouterContext(<EventEditor {...buildEventEditorProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
