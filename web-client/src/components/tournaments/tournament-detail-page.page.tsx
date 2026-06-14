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

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
