import { render, screen, within, type Container } from '@/test/utilities'

import {
  TournamentPathList,
  type TournamentPathListProps,
} from './tournament-path-list'
import { buildTournamentPathListProps } from './tournament-path-list.factory'
import { tournamentPathRowPage } from './tournament-path-list/tournament-path-row.page'

const scoped = (container: Container) => ({
  /** The list section, or null when there is no schedule to show. */
  queryList() {
    return container.queryByTestId('tournament-panel-path')
  },
  /** The section heading (`Your matches`). */
  getHeading(name: string | RegExp) {
    return container.getByRole('heading', { name })
  },
  /** Every schedule row, in render order. */
  getRows() {
    const list = container.getByTestId('tournament-panel-path')
    return within(list).getAllByRole('listitem')
  },
  // The row's own internals are pinned by its quartet; reuse its queries rather
  // than re-deriving them here.
  ...tournamentPathRowPage.within(container),
})

/**
 * Test page-object for `TournamentPathList`. Pure view-in — no router, no
 * network — so tests read synchronously after `render`.
 */
export const tournamentPathListPage = {
  render(overrides: Partial<TournamentPathListProps> = {}) {
    render(<TournamentPathList {...buildTournamentPathListProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
