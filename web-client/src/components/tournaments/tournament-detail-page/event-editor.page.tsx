import { render, screen, type Container } from '@/test/utilities'

import { EventEditor, type EventEditorProps } from './event-editor'
import { buildEventEditorProps } from './event-editor.factory'

const scoped = (container: Container) => ({
  getSectionTab(label: string) {
    return container.getByRole('tab', { name: label })
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
