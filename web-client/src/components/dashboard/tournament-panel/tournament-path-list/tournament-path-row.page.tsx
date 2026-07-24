import { render, screen, type Container } from '@/test/utilities'

import {
  TournamentPathRow,
  type TournamentPathRowProps,
} from './tournament-path-row'
import { buildTournamentPathRowProps } from './tournament-path-row.factory'

const scoped = (container: Container) => ({
  /** The row with this ordinal label (`M1`, `M2`, …). */
  getRow(label: string) {
    return container.getByTestId(`tournament-panel-path-row-${label}`)
  },
  /** The same row, or null — for asserting a row is absent. */
  queryRow(label: string) {
    return container.queryByTestId(`tournament-panel-path-row-${label}`)
  },
})

/**
 * Test page-object for `TournamentPathRow`. Rows are `<li>`s addressed by their
 * ordinal label, since a schedule can repeat an opponent and nothing else about
 * a row is unique. Pure view-in — no router, no network.
 */
export const tournamentPathRowPage = {
  render(overrides: Partial<TournamentPathRowProps> = {}) {
    const props = buildTournamentPathRowProps(overrides)
    render(
      <ul>
        <TournamentPathRow {...props} />
      </ul>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
