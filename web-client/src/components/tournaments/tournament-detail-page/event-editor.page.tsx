import { render, screen, type Container } from '@/test/utilities'

import { EventEditor, type EventEditorProps } from './event-editor'
import { buildEventEditorProps } from './event-editor.factory'

const scoped = (container: Container) => ({
  getSectionTab(label: string) {
    return container.getByRole('tab', { name: label })
  },
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
    render(<EventEditor {...buildEventEditorProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
