import { render, screen, type Container } from '@/test/utilities'

import {
  TournamentDetailPage,
  type TournamentDetailPageProps,
} from './tournament-detail-page'
import { buildTournamentDetailPageProps } from './tournament-detail-page.factory'
import { eventsTabPage } from './tournament-detail-page/events-tab.page'

const scoped = (container: Container) => ({
  getTab(name: string) {
    return container.getByRole('tab', { name })
  },
  getBackCrumb() {
    return container.getByRole('button', { name: 'Tournaments' })
  },
  getLifecycleButton(name: RegExp) {
    return container.getByRole('button', { name })
  },
  /** The Days stat's figure and its unit, read as one string. The unit is a
   * styled `<span>` sitting beside the figure, so the DOM text carries no space
   * ("2days") even though a CSS margin renders one — assert against the DOM, not
   * against what the eye sees. */
  getDaysStat() {
    return container.getByText('Days', { selector: 'div' }).previousElementSibling
      ?.textContent
  },
  queryLifecycleButton(name: RegExp) {
    return container.queryByRole('button', { name })
  },
  ...eventsTabPage.within(container),
})

/** Test page-object for `TournamentDetailPage`. */
export const tournamentDetailPagePage = {
  render(overrides: Partial<TournamentDetailPageProps> = {}) {
    render(<TournamentDetailPage {...buildTournamentDetailPageProps(overrides)} />)
  },
  /** The event editor's save button (the sheet portals to the body). */
  getEditorSaveButton() {
    return screen.getByRole('button', { name: /Create event|Save changes/ })
  },
  /** The editor's name field. A NEW event starts blank (`emptyEvent`), and a blank
   * name is now refused in the form — so a page-level test that wants to reach the
   * *server* has to fill this in first, exactly as an organizer does. */
  getEditorNameInput() {
    return screen.getByLabelText(/Event name/)
  },
  /** The event editor sheet — present exactly while it is open. A refused save
   * must leave it here, holding the organizer's work. */
  queryEditor() {
    return screen.queryByRole('dialog')
  },
  /** The editor's report of a refused save. */
  queryEditorFailure() {
    return screen.queryByTestId('event-editor-error')
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
