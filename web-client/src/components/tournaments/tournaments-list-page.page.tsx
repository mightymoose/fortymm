import { render, screen, type Container } from '@/test/utilities'

import {
  TournamentsListPage,
  type TournamentsListPageProps,
} from './tournaments-list-page'
import { buildTournamentsListPageProps } from './tournaments-list-page.factory'
import { tournamentCardPage } from './tournament-card.page'

const scoped = (container: Container) => ({
  getSearch() {
    return container.getByLabelText(/Search tournaments/)
  },
  getStatusTab(label: string) {
    return container.getByRole('tab', { name: label })
  },
  getNewButton() {
    return container.getAllByRole('button', { name: /New tournament/ })[0]
  },
  getResultCount() {
    return container.getByText(/results?$/)
  },
  /** A card's open target, by tournament name. */
  getCard(name: string) {
    return container.getByRole('button', { name })
  },
  queryCard(name: string) {
    return container.queryByRole('button', { name })
  },
  /** The confirm button inside the delete dialog (portaled to the body). */
  getConfirmDeleteButton() {
    return screen.getByRole('button', { name: /^Delete$/ })
  },
  /** Reuse the card delete control query. */
  ...tournamentCardPage.within(container),
})

/** Test page-object for `TournamentsListPage`. */
export const tournamentsListPagePage = {
  render(overrides: Partial<TournamentsListPageProps> = {}) {
    render(<TournamentsListPage {...buildTournamentsListPageProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
