import { render, screen, type Container } from '@/test/utilities'

import { EventEditor, type EventEditorProps } from './event-editor'
import { buildEventEditorProps } from './event-editor.factory'

const scoped = (container: Container) => ({
  getSectionTab(label: string) {
    return container.getByRole('tab', { name: label })
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
  getNameInput() {
    return container.getByLabelText(/Event name/)
  },
  getPlayerLimitInput() {
    return container.getByLabelText(/Player limit/)
  },
  getEntryFeeInput() {
    return container.getByLabelText(/Entry fee/)
  },
  /** An inline validation/server error rendered below a Basics field. */
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
    render(<EventEditor {...buildEventEditorProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
