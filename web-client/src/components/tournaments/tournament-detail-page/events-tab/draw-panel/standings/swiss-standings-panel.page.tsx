import { render, screen, type Container } from '@/test/utilities'

import { standingsTablePage } from './standings-table.page'
import { SwissStandingsPanel } from './swiss-standings-panel'
import {
  buildSwissStandingsPanelProps,
  type SwissStandingsPanelScenario,
} from './swiss-standings-panel.factory'

/** The accessible name a swiss table carries — the event, since there is no pool to name.
 * The panel's own wiring, written once. */
const tableName = (eventName: string) => `Standings for ${eventName}`

const scoped = (container: Container) => {
  // The table is the very `StandingsTable` a pool renders, so its readers are
  // `standingsTablePage`'s — composed, not re-implemented. A second row-slice loop here
  // would be this file describing a table it does not own.
  const table = standingsTablePage.within(container)

  return {
    /** The whole swiss results block, by event id. */
    getPanel(eventId: string) {
      return container.getByTestId(`swiss-standings-panel-${eventId}`)
    },
    queryPanel(eventId: string) {
      return container.queryByTestId(`swiss-standings-panel-${eventId}`)
    },

    /** The panel's landmark by its accessible name — a `<section>` with `aria-labelledby`
     * is a `region`, so this only resolves while the heading is still wired to the
     * section. */
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

    /** The table's player names, top to bottom (the rendered order) — the Player column,
     * asked for by its header rather than by an index a new column would shift. */
    getRowNames(eventName: string) {
      return table.getColumnUnder(tableName(eventName), 'Player')
    },

    /**
     * One column of the table, read top to bottom and addressed by its **header's full word**
     * ("Buchholz", "Wins") rather than by index.
     *
     * By index would be the obvious thing and is a trap: a swiss table's Buchholz column sits
     * between Losses and Game difference, so every index after it shifts — and an
     * index-addressed assertion does not fail when that happens, it silently starts reading
     * the neighbour it displaced. Asking by header also ties each cell to the heading a
     * screen-reader user hears above it.
     *
     * The lookup itself is the shared table's (`standingsTablePage.getColumnUnder`), because
     * the table is the shared table — this file only supplies the accessible name a swiss
     * event's table carries.
     */
    getColumnUnder(eventName: string, header: string) {
      return table.getColumnUnder(tableName(eventName), header)
    },

    /** A pool table's test hook, which must NEVER appear here: swiss has no pools, so a
     * `pool-standings-…` node in this panel would mean a forged pool id reached the DOM. */
    queryPoolTables() {
      return container.queryAllByTestId(/^pool-standings-/)
    },
  }
}

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
