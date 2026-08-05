import { render, screen, within, type Container } from '@/test/utilities'

import { SwissStandingsPanel } from './swiss-standings-panel'
import {
  buildSwissStandingsPanelProps,
  type SwissStandingsPanelScenario,
} from './swiss-standings-panel.factory'

const scoped = (container: Container) => ({
  /** The whole swiss results block, by event id. */
  getPanel(eventId: string) {
    return container.getByTestId(`swiss-standings-panel-${eventId}`)
  },
  queryPanel(eventId: string) {
    return container.queryByTestId(`swiss-standings-panel-${eventId}`)
  },

  /** The panel's landmark by its accessible name — a `<section>` with `aria-labelledby` is
   * a `region`, so this only resolves while the heading is still wired to the section. */
  getRegion() {
    return container.getByRole('region', { name: 'Standings' })
  },

  /** The champion callout, by event id — shown only once every round is decided. `query…`
   * because its absence is half of what the tests assert. */
  queryChampion(eventId: string) {
    return container.queryByTestId(`swiss-champion-${eventId}`)
  },

  /** Every table in the panel, by accessible name. Swiss has **one** — the claim that
   * distinguishes it from the pooled block, so the count is part of the assertion. */
  getTableNames() {
    return container
      .getAllByRole('table')
      .map((t: HTMLElement) => t.getAttribute('aria-label') ?? '')
  },

  /** The table's player names, top to bottom (the rendered order). */
  getRowNames(eventName: string) {
    return within(container.getByRole('table', { name: `Standings for ${eventName}` }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => (within(row).getAllByRole('cell')[1].textContent ?? '').trim())
  },

  /** One numeric column of the table, read top to bottom by its **column index** — the same
   * order the header row declares (`#`, Player, W, L, Diff, GW). */
  getColumn(eventName: string, index: number) {
    return within(container.getByRole('table', { name: `Standings for ${eventName}` }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => (within(row).getAllByRole('cell')[index].textContent ?? '').trim())
  },

  /** A pool table's test hook, which must NEVER appear here: swiss has no pools, so a
   * `pool-standings-…` node in this panel would mean a forged pool id reached the DOM. */
  queryPoolTables() {
    return container.queryAllByTestId(/^pool-standings-/)
  },
})

/** Test page-object for `SwissStandingsPanel`. */
export const swissStandingsPanelPage = {
  render(overrides: SwissStandingsPanelScenario = {}) {
    render(<SwissStandingsPanel {...buildSwissStandingsPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
