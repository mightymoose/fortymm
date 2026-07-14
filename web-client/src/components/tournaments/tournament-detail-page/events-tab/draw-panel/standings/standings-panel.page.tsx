import { render, screen, within, type Container } from '@/test/utilities'

import { StandingsPanel, type StandingsPanelProps } from './standings-panel'
import { buildStandingsPanelProps } from './standings-panel.factory'

const scoped = (container: Container) => ({
  /** The whole results block, by event id. `query…` because the panel renders NOTHING for
   * an event with no results — the assertion for that state is that this is absent. */
  getPanel(eventId: string) {
    return container.getByTestId(`standings-panel-${eventId}`)
  },
  queryPanel(eventId: string) {
    return container.queryByTestId(`standings-panel-${eventId}`)
  },

  /** The champion callout, by event id — shown only for a complete, single-champion event.
   * `query…` because its absence is half of what the tests assert. */
  queryChampion(eventId: string) {
    return container.queryByTestId(`standings-champion-${eventId}`)
  },

  /** Every pool table in the panel, by their accessible names — one per pool. */
  getPoolTableNames() {
    return container
      .getAllByRole('table')
      .map((t: HTMLElement) => t.getAttribute('aria-label') ?? '')
  },

  /** One pool table's player names, top to bottom (the rendered order) — for the "the
   * panel shows each pool, joined to names" assertion. */
  getRowNames(poolName: string) {
    return within(container.getByRole('table', { name: `Standings for ${poolName}` }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => (within(row).getAllByRole('cell')[1].textContent ?? '').trim())
  },
})

/** Test page-object for `StandingsPanel`. */
export const standingsPanelPage = {
  render(overrides: Partial<StandingsPanelProps> = {}) {
    render(<StandingsPanel {...buildStandingsPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
