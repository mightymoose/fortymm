import { renderedHtml } from '@/test/rendered-html'
import { render, screen, within, type Container } from '@/test/utilities'

import { StandingsPanel } from './standings-panel'
import {
  buildStandingsPanelProps,
  type StandingsPanelScenario,
} from './standings-panel.factory'

const scoped = (container: Container) => ({
  /** The whole results block, by event id. `query…` because the panel renders NOTHING for
   * an event with no results — the assertion for that state is that this is absent. */
  getPanel(eventId: string) {
    return container.getByTestId(`standings-panel-${eventId}`)
  },
  queryPanel(eventId: string) {
    return container.queryByTestId(`standings-panel-${eventId}`)
  },

  /** The panel's whole rendered DOM (React ids normalized) — the equivalence guard's
   * subject: an inline snapshot of this reds on ANY rendered change. */
  getPanelHtml(eventId: string) {
    return renderedHtml(container.getByTestId(`standings-panel-${eventId}`))
  },

  /** The panel's landmark by its accessible name — a `<section>` with `aria-labelledby` is
   * a `region`, so this only resolves while the heading is still wired to the section.
   * (The snapshot normalizes the generated id away, so the wiring is asserted here.) */
  getRegion() {
    return container.getByRole('region', { name: 'Standings' })
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
  render(overrides: StandingsPanelScenario = {}) {
    render(<StandingsPanel {...buildStandingsPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
