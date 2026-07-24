import { render, screen, within, type Container } from '@/test/utilities'

import {
  TournamentStatsStrip,
  type TournamentStatsStripProps,
} from './tournament-stats-strip'
import { buildTournamentStatsStripProps } from './tournament-stats-strip.factory'

const scoped = (container: Container) => ({
  /** The strip itself. */
  getStrip() {
    return container.getByTestId('tournament-panel-stats')
  },
  /** The strip, or null when the parent chose not to render one. */
  queryStrip() {
    return container.queryByTestId('tournament-panel-stats')
  },
  /**
   * The value rendered under a tile's label — the `<dd>` that follows the
   * `<dt>` with this text. Queried structurally rather than by testid so the
   * pairing the markup claims (a definition list) is the pairing under test.
   */
  getTileValue(label: string) {
    const term = within(container.getByTestId('tournament-panel-stats')).getByText(
      label,
    )
    const value = term.nextElementSibling
    if (!(value instanceof HTMLElement)) {
      throw new Error(`No value follows the "${label}" tile label.`)
    }
    return value
  },
})

/**
 * Test page-object for `TournamentStatsStrip`. No router or network — the strip
 * is pure view-in, DOM-out, so tests read synchronously after `render`.
 */
export const tournamentStatsStripPage = {
  render(overrides: Partial<TournamentStatsStripProps> = {}) {
    render(<TournamentStatsStrip {...buildTournamentStatsStripProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
