import { render, screen, type Container } from '@/test/utilities'

import { ResultsPanel, type ResultsPanelProps } from './results-panel'
import { buildResultsPanelProps } from './results-panel.factory'

const scoped = (container: Container) => ({
  /** The standings block, by event id — present only when the results are the `standings`
   * arm. `query…` because its absence is what the finishes/no-results cases assert. */
  queryStandingsPanel(eventId: string) {
    return container.queryByTestId(`standings-panel-${eventId}`)
  },

  /** The finishes block, by event id — present only when the results are the `finishes`
   * arm. `query…` for the same reason. */
  queryFinishesPanel(eventId: string) {
    return container.queryByTestId(`finishes-panel-${eventId}`)
  },

  /** The **two-stage** block, by event id — present only when the results are the
   * `standings_then_finishes` arm. It wraps the other two panels rather than replacing
   * them, so both of the queries above resolve inside it. */
  queryTwoStagePanel(eventId: string) {
    return container.queryByTestId(`two-stage-panel-${eventId}`)
  },

  /** Each block's own champion callout, by event id. The two-stage arm asserts the STAGE
   * callouts are absent (it crowns once, itself), so all three need a `query…`. */
  queryStandingsChampion(eventId: string) {
    return container.queryByTestId(`standings-champion-${eventId}`)
  },
  queryFinishesChampion(eventId: string) {
    return container.queryByTestId(`finishes-champion-${eventId}`)
  },
  queryTwoStageChampion(eventId: string) {
    return container.queryByTestId(`two-stage-champion-${eventId}`)
  },

  /** A block's champion callout, by its full test id. The panels are handed their view now,
   * so this is where "the RIGHT data reached the right panel" is asserted — a section
   * wrapper alone would render for an empty view too. */
  getChampion(testId: string) {
    return container.getByTestId(testId)
  },

  /** The rendered table's accessible name — for the finishes arm, this is the only place
   * the **event's name** shows up, and `ResultsPanel` is now the only thing that passes
   * it. */
  getTableName() {
    return container.getByRole('table').getAttribute('aria-label')
  },
})

/** Test page-object for `ResultsPanel`. */
export const resultsPanelPage = {
  render(overrides: Partial<ResultsPanelProps> = {}) {
    render(<ResultsPanel {...buildResultsPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
