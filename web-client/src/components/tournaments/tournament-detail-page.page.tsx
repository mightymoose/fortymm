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
  /** The header's venue meta item (pin icon + address). The whole item — icon
   * included — is absent when venue, city, and region are all blank, so this is
   * a `query`: its absence is the assertion (#994). */
  queryVenueLine() {
    return container.queryByTestId('tournament-venue-line')
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
  /** The event editor's name field (portalled to the body). */
  getEditorNameInput() {
    return screen.getByLabelText(/Event name/)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
